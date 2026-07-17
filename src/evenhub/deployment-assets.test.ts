import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  WHISPER_BASE_EN_SHA1,
  WHISPER_CPP_ARM64_SHA256,
  WHISPER_CPP_VERSION,
} from './whisper-assets.js';

const root = process.cwd();
const deploy = path.join(root, 'deploy', 'evenhub');
const read = (...parts: string[]) =>
  fs.readFileSync(path.join(deploy, ...parts), 'utf8');

describe('EvenHub deployment assets', () => {
  it('pins the reviewed runtime environment exactly', () => {
    expect(read('config', 'evenhub.env').trim().split('\n')).toEqual([
      'EVENHUB_ENABLED=true',
      'EVENHUB_HOST=127.0.0.1',
      'EVENHUB_PORT=18791',
      'EVENHUB_PUBLIC_ORIGIN=https://nanoclaw.local',
      'EVENHUB_WHISPER_URL=http://127.0.0.1:8178/inference',
      'EVENHUB_MAX_AUDIO_BYTES=960000',
      'EVENHUB_PAIRING_TTL_MS=300000',
      'EVENHUB_TURN_RETENTION_MS=604800000',
    ]);
  });

  it('terminates only the fixed HTTPS origin and proxies only the API prefix', () => {
    const caddy = read('Caddyfile');
    expect(caddy).toContain('nanoclaw.local {');
    expect(caddy).toContain('auto_https disable_redirects');
    expect(caddy).toMatch(/servers \{\s+protocols h1 h2\s+\}/);
    expect(caddy).toContain('bind {$NANOCLAW_LAN_ADDRESS}');
    expect(caddy).toContain('tls internal');
    expect(caddy).toContain('@evenhub path /api/even/*');
    expect(caddy).toContain('reverse_proxy 127.0.0.1:18791');
    expect(caddy).toMatch(/handle \{\s+respond 404/);
    expect(caddy.match(/reverse_proxy/g)).toHaveLength(1);
  });

  it('advertises one IPv4 HTTPS service through Avahi', () => {
    const avahi = read('avahi', 'nanoclaw.service');
    expect(avahi).toContain('<service protocol="ipv4">');
    expect(avahi).toContain('<type>_https._tcp</type>');
    expect(avahi).toContain('<port>443</port>');
    expect(avahi).not.toContain('_http._tcp');
  });

  it('limits ingress to the rendered LAN interface/subnet and denies forwarding', () => {
    const firewall = read('firewall', 'nanoclaw-evenhub.nft.template');
    expect(firewall).toContain(
      'define lan_interface = "REPLACE_LAN_INTERFACE"',
    );
    expect(firewall).toContain('define lan_subnet = 192.0.2.0/24');
    expect(firewall).toContain('destroy table inet nanoclaw_evenhub');
    expect(firewall).toContain(
      'iifname $lan_interface ip saddr $lan_subnet tcp dport 443 accept',
    );
    expect(firewall.match(/tcp dport 443 drop/g)).toHaveLength(2);
    expect(firewall.indexOf('tcp dport 443 accept')).toBeLessThan(
      firewall.indexOf('tcp dport 443 drop'),
    );
    expect(firewall).toMatch(/chain forward[\s\S]*tcp dport 443 drop/);
  });

  it('runs the pinned Whisper command as a hardened loopback service', () => {
    const unit = read('systemd', 'nanoclaw-whisper.service');
    expect(unit).toContain('User=nanoclaw-whisper');
    expect(unit).toContain('Group=nanoclaw-whisper');
    expect(unit).toContain(
      'ExecStart=/usr/local/bin/whisper-server --model /var/lib/nanoclaw/whisper/ggml-base.en.bin --host 127.0.0.1 --port 8178 --threads 4 --processors 1 --language en --no-timestamps',
    );
    expect(unit).not.toContain('--no-context');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=2');
    expect(unit).toContain('NoNewPrivileges=true');
    expect(unit).toContain('PrivateTmp=true');
    expect(unit).toContain(
      'ReadOnlyPaths=/var/lib/nanoclaw/whisper /opt/nanoclaw/whisper-v1.9.1',
    );
    expect(unit).toContain('IPAddressDeny=any');
    expect(unit).toContain('IPAddressAllow=localhost');
    expect(unit).toMatch(/MemoryMax=\d+[MG]/);
  });

  it('orders NanoClaw after Whisper without making it required', () => {
    const dropIn = read('systemd', 'nanoclaw.service.d', 'evenhub.conf');
    expect(dropIn).toContain(
      'Wants=network-online.target nanoclaw-whisper.service',
    );
    expect(dropIn).toContain(
      'After=network-online.target nanoclaw-whisper.service',
    );
    expect(dropIn).not.toContain('Requires=nanoclaw-whisper.service');
    expect(dropIn).toContain('EnvironmentFile=/etc/nanoclaw/evenhub.env');
  });

  it('requires the firewall before Caddy can expose the LAN listener', () => {
    const caddy = read('systemd', 'caddy.service.d', 'evenhub.conf');
    const firewall = read('systemd', 'nanoclaw-evenhub-firewall.service');
    expect(caddy).toContain('Requires=nanoclaw-evenhub-firewall.service');
    expect(caddy).toContain('EnvironmentFile=/etc/nanoclaw/evenhub-caddy.env');
    expect(firewall).toContain('Before=caddy.service');
    expect(firewall).toContain(
      'ExecStart=/usr/sbin/nft -f /etc/nftables.d/nanoclaw-evenhub.nft',
    );
  });

  it('records the same pinned Whisper checksums as the verifier', () => {
    const checksums = read('WHISPER_CHECKSUMS');
    expect(WHISPER_CPP_VERSION).toBe('v1.9.1');
    expect(checksums).toContain(WHISPER_CPP_ARM64_SHA256);
    expect(checksums).toContain(WHISPER_BASE_EN_SHA1);
  });

  it('pins the private plugin toolchain, origin, and least permissions', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, 'evenhub', 'package.json'), 'utf8'),
    ) as {
      private: boolean;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'evenhub', 'app.json'), 'utf8'),
    ) as {
      package_id: string;
      permissions: Array<{ name: string; whitelist?: string[] }>;
    };
    expect(packageJson.private).toBe(true);
    expect(packageJson.dependencies).toEqual({
      '@evenrealities/even_hub_sdk': '0.0.12',
      '@evenrealities/pretext': '0.1.4',
    });
    expect(packageJson.devDependencies).toEqual({
      '@evenrealities/evenhub-cli': '0.1.13',
      '@evenrealities/evenhub-simulator': '0.8.0',
      typescript: '5.7.3',
      vite: '8.1.5',
      vitest: '4.1.10',
    });
    expect(manifest.package_id).toBe('dev.inhesrom.nanoclaw.evenhub');
    expect(manifest.permissions.map(({ name }) => name)).toEqual([
      'g2-microphone',
      'network',
    ]);
    expect(manifest.permissions[1].whitelist).toEqual([
      'https://nanoclaw.local',
    ]);
    expect(
      fs
        .readFileSync(path.join(root, 'evenhub', '.env.production'), 'utf8')
        .trim(),
    ).toBe('VITE_EVENHUB_ORIGIN=https://nanoclaw.local');
    expect(
      fs.readFileSync(path.join(root, 'evenhub', 'vite.config.ts'), 'utf8'),
    ).toContain('configuredOrigin !== APPROVED_ORIGIN');
  });

  it('documents installation, restart, rollback, and troubleshooting', () => {
    const guide = fs.readFileSync(
      path.join(root, 'docs', 'evenhub-lan-deployment.md'),
      'utf8',
    );
    expect(guide).toContain('## Before installation');
    expect(guide).toContain('## Restart and troubleshooting');
    expect(guide).toContain('## Rollback');
    expect(guide).toContain('EVENHUB_ENABLED=false');
    expect(guide).toContain('pack:verify');
    expect(guide).toContain('root.crt');
  });
});
