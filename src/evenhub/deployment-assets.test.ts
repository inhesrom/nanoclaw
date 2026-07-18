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
  it('documents a valid private origin in the root environment sample', () => {
    const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    expect(example).toContain('# Tailscale-only EvenHub G2 bridge');
    expect(example).toContain(
      'EVENHUB_PUBLIC_ORIGIN=https://nanoclaw.example.ts.net',
    );
    expect(example).not.toContain(
      'EVENHUB_PUBLIC_ORIGIN=https://nanoclaw.local',
    );
  });

  it('tracks a fail-closed runtime environment template', () => {
    expect(read('config', 'evenhub.env.template').trim().split('\n')).toEqual([
      'EVENHUB_ENABLED=true',
      'EVENHUB_HOST=127.0.0.1',
      'EVENHUB_PORT=18791',
      'EVENHUB_PUBLIC_ORIGIN=REPLACE_WITH_TAILSCALE_HTTPS_ORIGIN',
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

  it('limits ingress and denies new LAN forwarding without breaking container replies', () => {
    const firewall = read('firewall', 'nanoclaw-evenhub.nft.template');
    expect(firewall).toContain(
      'define lan_interface = "REPLACE_LAN_INTERFACE"',
    );
    expect(firewall).toContain('define lan_subnet = 192.0.2.0/24');
    expect(firewall).toContain('destroy table inet nanoclaw_evenhub');
    expect(firewall).toContain(
      'iifname $lan_interface ip saddr $lan_subnet tcp dport 443 accept',
    );
    expect(firewall).toContain(
      'iifname "lo" tcp dport { 443, 8178, 18791 } accept',
    );
    expect(firewall).toContain(
      'iifname "tailscale0" ip saddr 100.64.0.0/10 tcp dport 443 accept',
    );
    expect(firewall).toContain(
      'iifname "tailscale0" ip6 saddr fd7a:115c:a1e0::/48 tcp dport 443 accept',
    );
    expect(firewall.match(/tcp dport 443 drop/g)).toHaveLength(1);
    expect(firewall.indexOf('tailscale0')).toBeLessThan(
      firewall.indexOf('tcp dport 443 drop'),
    );
    expect(firewall.indexOf('iifname "lo"')).toBeLessThan(
      firewall.indexOf('tcp dport 443 drop'),
    );
    expect(firewall).toContain('tcp dport { 8178, 18791 } drop');
    expect(firewall).toMatch(
      /chain forward[\s\S]*ct state established,related accept/,
    );
    expect(firewall).toMatch(
      /chain forward[\s\S]*iifname \$lan_interface drop/,
    );
    expect(
      firewall.indexOf('ct state established,related accept'),
    ).toBeLessThan(firewall.indexOf('iifname $lan_interface drop'));
  });

  it('runs the pinned Moonshine daemon as a hardened loopback service', () => {
    const unit = read('systemd', 'nanoclaw-moonshine.service');
    expect(unit).toContain('User=nanoclaw-stt');
    expect(unit).toContain('Group=nanoclaw-stt');
    expect(unit).toContain(
      'ExecStart=/opt/nanoclaw/moonshine-0.0.69/bin/python /opt/nanoclaw/moonshine-server/moonshine_server.py --profile /etc/nanoclaw/stt-selected-profile.json --host 127.0.0.1 --port 8178',
    );
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=2');
    expect(unit).toContain('NoNewPrivileges=true');
    expect(unit).toContain('PrivateTmp=true');
    expect(unit).toContain(
      'ReadOnlyPaths=/var/lib/nanoclaw/stt /opt/nanoclaw/moonshine-0.0.69 /opt/nanoclaw/moonshine-server /etc/nanoclaw/stt-selected-profile.json',
    );
    expect(unit).toContain('IPAddressDeny=any');
    expect(unit).toContain('IPAddressAllow=localhost');
    expect(unit).toMatch(/MemoryMax=\d+[MG]/);
  });

  it('requires Moonshine before NanoClaw can accept streaming sessions', () => {
    const dropIn = read('systemd', 'nanoclaw.service.d', 'evenhub.conf');
    expect(dropIn).toContain('Wants=network-online.target');
    expect(dropIn).toContain('Requires=nanoclaw-moonshine.service');
    expect(dropIn).toContain(
      'After=network-online.target nanoclaw-moonshine.service',
    );
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

  it('configures persistent tailnet-only HTTPS Serve after every dependency', () => {
    const unit = read('systemd', 'nanoclaw-tailscale-serve.service');
    expect(unit).toContain(
      'Requires=tailscaled.service nanoclaw.service nanoclaw-moonshine.service nanoclaw-evenhub-firewall.service',
    );
    expect(unit).toContain(
      'After=network-online.target tailscaled.service nanoclaw.service nanoclaw-moonshine.service nanoclaw-evenhub-firewall.service',
    );
    expect(unit).toContain(
      'ExecStart=/usr/bin/tailscale serve --bg --https=443 http://127.0.0.1:18791',
    );
    expect(unit).toContain(
      'ExecStop=-/usr/bin/tailscale serve --https=443 off',
    );
    expect(unit).toContain('RestrictAddressFamilies=AF_UNIX');
    expect(unit).not.toContain('funnel');
    expect(unit).not.toContain('0.0.0.0');
    expect(read('systemd', 'nanoclaw-evenhub-firewall.service')).toContain(
      'Before=caddy.service nanoclaw-tailscale-serve.service',
    );
  });

  it('captures private pre-Tailscale state without credential material', () => {
    const snapshot = read('snapshot-before-tailscale.sh');
    expect(snapshot).toContain('umask 077');
    expect(snapshot).toContain('tailscale status --json');
    expect(snapshot).toContain('tailscale serve status --json');
    expect(snapshot).toContain('tailscale funnel status --json');
    expect(snapshot).toContain('nft list ruleset');
    expect(snapshot).not.toContain('tailscale debug prefs');
    expect(snapshot).not.toContain('journalctl');
  });

  it('records the same pinned Whisper checksums as the verifier', () => {
    const checksums = read('WHISPER_CHECKSUMS');
    expect(WHISPER_CPP_VERSION).toBe('v1.9.1');
    expect(checksums).toContain(WHISPER_CPP_ARM64_SHA256);
    expect(checksums).toContain(WHISPER_BASE_EN_SHA1);
  });

  it('pins the private plugin toolchain, origin template, and least permissions', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, 'evenhub', 'package.json'), 'utf8'),
    ) as {
      private: boolean;
      version: string;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'evenhub', 'app.template.json'), 'utf8'),
    ) as {
      package_id: string;
      version: string;
      permissions: Array<{ name: string; whitelist?: string[] }>;
    };
    expect(packageJson.private).toBe(true);
    expect(packageJson.version).toBe('0.3.0');
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
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.permissions.map(({ name }) => name)).toEqual([
      'g2-microphone',
      'network',
    ]);
    expect(manifest.permissions[1].whitelist).toEqual([
      'https://nanoclaw.example.ts.net',
      'wss://nanoclaw.example.ts.net',
    ]);
    expect(
      fs
        .readFileSync(path.join(root, 'evenhub', '.env.production'), 'utf8')
        .trim(),
    ).toBe('VITE_EVENHUB_ORIGIN=https://nanoclaw.example.ts.net');
    expect(
      fs.readFileSync(path.join(root, 'evenhub', 'vite.config.ts'), 'utf8'),
    ).toContain('requireTailnetOrigin');
    expect(
      fs.readFileSync(path.join(root, 'evenhub', 'vite.config.ts'), 'utf8'),
    ).toContain("loadEnv('private'");
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toContain(
      'evenhub/.env.private',
    );
    expect(
      fs.readFileSync(
        path.join(root, 'evenhub', 'scripts', 'private-package.mjs'),
        'utf8',
      ),
    ).toContain("url.hostname.endsWith('.ts.net')");
  });

  it('pins the private Moonshine runtime and leaves selection evidence pending', () => {
    const lock = read('moonshine', 'requirements-aarch64-py313.lock');
    expect(lock).toContain(
      'moonshine-voice==0.0.69 --hash=sha256:1cda44b5cd3869e1b9165715de211d342b6de52bdd51bf99b79a1e44bd0f20e7',
    );
    const requirementLines = lock
      .trim()
      .split('\n')
      .filter((line) => !line.startsWith('#'));
    expect(
      requirementLines.every((line) =>
        /==[^ ]+ --hash=sha256:[a-f0-9]{64}$/.test(line),
      ),
    ).toBe(true);
    const profile = JSON.parse(read('moonshine', 'selected-profile.json')) as {
      selectionStatus: string;
      components: unknown[];
      evidence: unknown;
    };
    expect(profile).toMatchObject({
      selectionStatus: 'pending_physical_benchmark',
      components: [],
      evidence: null,
    });
    const daemon = read('moonshine', 'moonshine_server.py');
    expect(daemon).toContain('log_output_text": "false"');
    expect(daemon).toContain('access_log=None');
    expect(daemon).not.toContain('logging.info(text');
    expect(daemon).toContain('runtime component hash mismatch');
    expect(daemon).toContain('runtime lock hash mismatch');
    expect(daemon).toContain('server hash mismatch');
    const renderer = read('moonshine', 'render-profile.mjs');
    expect(renderer).toContain('use select-profile.mjs with passing evidence');
    expect(renderer).toContain('licenses\\/.*');
    const selector = read('moonshine', 'select-profile.mjs');
    expect(selector).toContain("final.decision !== 'pass'");
    expect(selector).toContain('Object.values(final.gates).every');
    expect(selector).toContain('Math.ceil(final.metrics.peakRssMiB * 1.25)');
    expect(selector).toContain('candidate component hashes do not match');
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

    const tailscaleGuide = fs.readFileSync(
      path.join(root, 'docs', 'evenhub-tailscale-deployment.md'),
      'utf8',
    );
    expect(tailscaleGuide).toContain(
      'deploy/evenhub/firewall/nanoclaw-evenhub.nft.template',
    );
    expect(tailscaleGuide).toContain('/etc/nftables.d/nanoclaw-evenhub.nft');
  });
});
