# EvenHub private LAN deployment

This runbook installs the private G2 slice on one Raspberry Pi 5. The checked-in
files under `deploy/evenhub/` are inert templates: building and testing them does
not modify systemd, Caddy, Avahi, nftables, the hostname, or the live NanoClaw
service.

The only supported route is:

```text
G2 companion → https://nanoclaw.local:443 → Caddy
                                         → 127.0.0.1:18791 NanoClaw
                                         → 127.0.0.1:8178 whisper-server
```

There is no HTTP, IP-address, WAN, cellular, Tailscale, or cloud transcription
fallback.

Caddy explicitly disables automatic HTTP redirects and HTTP/3, leaving only
HTTP/1.1 and HTTP/2 on TCP 443. Port 80 must refuse the connection; an HTTP
redirect or UDP 443 listener is a failed boundary check.

## Before installation

Use a 64-bit Raspberry Pi OS, active cooling, no overclock, and a fixed private
LAN address. Record the LAN interface, private IPv4 subnet in CIDR notation, and
Pi address. Install Caddy, Avahi, nftables, and a Node.js version accepted by the
root project. Do not expose TCP 443 through the router.

Build and test from a clean dependency install:

```bash
npm ci
npm run typecheck
npm test
cd evenhub
npm ci
npm test
npm run pack:verify
npm run pack:private
sha256sum nanoclaw-evenhub-0.1.0.ehpk
```

`pack:verify` builds two private packages in an isolated temporary directory and
fails if their SHA-256 digests differ. Keep the resulting `.ehpk` private and
sideload it on the one companion phone; do not submit it to the EvenHub portal.

## Verify and provision Whisper

The approved inputs are recorded in `deploy/evenhub/WHISPER_CHECKSUMS`:

- whisper.cpp `v1.9.1` arm64 archive SHA-256:
  `e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3`
- `ggml-base.en.bin` SHA-1:
  `137c40403d78fd54d454da0f9bd998f78703390c`

Verify both before copying either into a service path:

```bash
npm run evenhub:whisper:verify -- \
  /path/to/whisper.cpp-v1.9.1-arm64-archive \
  /path/to/ggml-base.en.bin
sudo useradd --system --home /var/lib/nanoclaw/whisper \
  --shell /usr/sbin/nologin nanoclaw-whisper
sudo install -d -o root -g root -m 0755 \
  /opt/nanoclaw/whisper-v1.9.1
sudo cp -a /path/to/extracted/whisper-bin-ubuntu-arm64/. \
  /opt/nanoclaw/whisper-v1.9.1/
sudo chown -R root:root /opt/nanoclaw/whisper-v1.9.1
sudo find /opt/nanoclaw/whisper-v1.9.1 -type d -exec chmod 0755 {} +
sudo find /opt/nanoclaw/whisper-v1.9.1 -type f -exec chmod 0644 {} +
sudo chmod 0755 /opt/nanoclaw/whisper-v1.9.1/whisper-server
sudo ln -s /opt/nanoclaw/whisper-v1.9.1/whisper-server \
  /usr/local/bin/whisper-server
sudo install -d -o root -g nanoclaw-whisper -m 0750 \
  /var/lib/nanoclaw/whisper
sudo install -o root -g nanoclaw-whisper -m 0440 \
  /path/to/ggml-base.en.bin \
  /var/lib/nanoclaw/whisper/ggml-base.en.bin
```

The official ARM64 archive is dynamically linked and uses an `$ORIGIN`
runpath. Keep its `libwhisper` and `libggml` files beside the executable in the
versioned `/opt` tree; copying only `whisper-server` makes the service fail at
load time. The `/usr/local/bin` entrypoint is a symlink to that verified tree.

Never start the service after a checksum mismatch. The initial `MemoryMax=1G`
ceiling is intentionally conservative; the hardware gate must replace it with
the measured peak RSS plus 25% before release.

## Render and validate host configuration

Copy `deploy/evenhub/config/evenhub.env` unchanged to
`/etc/nanoclaw/evenhub.env` with mode `0640`. Copy
`evenhub-caddy.env.template`, replace its documentation address with the fixed
Pi LAN address, and install it as `/etc/nanoclaw/evenhub-caddy.env`. Any change
to the eight `EVENHUB_*` values is rejected by NanoClaw at startup.

Copy `deploy/evenhub/firewall/nanoclaw-evenhub.nft.template`, replace
`REPLACE_LAN_INTERFACE` and `192.0.2.0/24`, and save it as
`/etc/nftables.d/nanoclaw-evenhub.nft`. Validate before loading:

```bash
sudo nft -c -f /etc/nftables.d/nanoclaw-evenhub.nft
```

The dedicated table accepts TCP 443 only on that interface from that IPv4
subnet, drops every other IPv4/IPv6 TCP 443 input, and drops forwarded TCP 443.
It leaves unrelated firewall policy alone. Keep an existing administrative
session open while first applying firewall changes.

Install the remaining assets at these exact locations:

| Repository asset                                           | Installed path                                          |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| `deploy/evenhub/Caddyfile`                                 | `/etc/caddy/Caddyfile`                                  |
| `deploy/evenhub/avahi/nanoclaw.service`                    | `/etc/avahi/services/nanoclaw.service`                  |
| `deploy/evenhub/systemd/nanoclaw-whisper.service`          | `/etc/systemd/system/nanoclaw-whisper.service`          |
| `deploy/evenhub/systemd/nanoclaw-evenhub-firewall.service` | `/etc/systemd/system/nanoclaw-evenhub-firewall.service` |
| `deploy/evenhub/systemd/nanoclaw.service.d/evenhub.conf`   | `/etc/systemd/system/nanoclaw.service.d/evenhub.conf`   |
| `deploy/evenhub/systemd/caddy.service.d/evenhub.conf`      | `/etc/systemd/system/caddy.service.d/evenhub.conf`      |

Set the hostname to `nanoclaw`, then validate every file without starting it:

```bash
sudo hostnamectl hostname nanoclaw
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemd-analyze verify \
  /etc/systemd/system/nanoclaw-whisper.service \
  /etc/systemd/system/nanoclaw-evenhub-firewall.service
sudo systemctl daemon-reload
```

The NanoClaw drop-in deliberately uses `Wants` and `After`, never `Requires`,
for Whisper so ordinary WhatsApp remains available during an STT outage. Caddy
does require the firewall unit and binds only the configured LAN address. The
Whisper unit runs as its own user, binds loopback, permits only loopback network
traffic, and reads a root-owned model.

## Start, trust, and pair

Start dependencies before NanoClaw:

```bash
sudo systemctl enable --now nanoclaw-evenhub-firewall.service
sudo systemctl enable --now avahi-daemon.service
sudo systemctl enable --now nanoclaw-whisper.service
sudo systemctl restart caddy.service
sudo systemctl restart nanoclaw.service
```

Caddy writes its local CA root at
`/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`. Transfer that
certificate directly to the one companion phone, verify its fingerprint out of
band, and explicitly trust it. A warning or changed certificate is a hard stop.

Confirm the public boundary and loopback-only listeners:

```bash
curl --fail https://nanoclaw.local/api/even/v1/healthz
curl --fail https://nanoclaw.local/api/even/v1/readyz
sudo ss -lntup | grep -E '(:443|127.0.0.1:18791|127.0.0.1:8178)'
sudo nft list table inet nanoclaw_evenhub
```

Health returns only version plus Whisper/WhatsApp `up|down` state. Readiness is
HTTP 200 only when the API, SQLite, Whisper, and the configured WhatsApp main
self-chat are ready; audio uploads receive retryable HTTP 503 while degraded.
Pair with `npm run evenhub:pair`, enter the one-time code in the companion view,
then revoke and re-pair once as the installation smoke test.

After the physical pairing and recording smoke test passes, continue with the
[G2 corpus and Pi Whisper benchmark](evenhub-whisper-benchmark.md). Do not arm
capture during installation or smoke testing.

## Restart and troubleshooting

For a routine restart, use dependency order:

```bash
sudo systemctl restart nanoclaw-whisper.service
sudo systemctl restart nanoclaw.service
sudo systemctl restart caddy.service avahi-daemon.service
```

Use `journalctl -u nanoclaw-whisper -u nanoclaw -u caddy -u avahi-daemon` and
the durable EvenHub turn row as the operational record. Logs contain event
names, turn IDs, state, attempt/elapsed metadata, sizes, and dependency state;
they must never contain bearer tokens, pairing codes, authorization headers,
audio, transcripts, or answer text.

- `nanoclaw.local` does not resolve: confirm hostname, Avahi status, UDP 5353
  LAN policy, and that the phone is on the same LAN.
- TLS warning: stop and re-verify the installed Caddy root fingerprint; never
  bypass the warning or switch to HTTP.
- readiness names `whisper`: inspect the Whisper journal, both checksums, model
  permissions, loopback `/health`, memory ceiling, and Pi throttling state.
- readiness names `whatsapp`: confirm the main self-chat registration and the
  WhatsApp channel connection; no other group satisfies readiness.
- Caddy will not start: verify the configured LAN address is assigned, validate
  the Caddyfile, and confirm the firewall unit is active.
- HTTP 409 idempotency mismatch or an authentication lockout: preserve the
  journal and turn row, revoke/re-pair if appropriate, and do not retry with a
  new payload under the old key.

## Rollback

First set `EVENHUB_ENABLED=false` in `/etc/nanoclaw/evenhub.env` and restart
NanoClaw. Remove the private plugin from the companion phone. This preserves
WhatsApp and the durable SQLite history while immediately disabling the LAN API.

Then stop Caddy and the dedicated services, remove the Caddy/Avahi/drop-in/env
files installed above, delete the `inet nanoclaw_evenhub` nftables table, reload
systemd, and restore the previous Caddyfile/hostname if they were shared with
another local service. Do not delete SQLite rows, model files, or logs until the
rollback has been reviewed. Re-enabling requires repeating checksum, TLS,
firewall, readiness, revoke/re-pair, and hardware acceptance checks.
