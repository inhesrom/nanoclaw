# EvenHub retained private LAN deployment

This runbook retains the original LAN diagnostic and rollback boundary on one
Raspberry Pi 5. EvenHub 0.3.1 uses the
[Tailscale deployment](evenhub-tailscale-deployment.md) as its sole application
route; it never falls back to this hostname. The
tracked files under `deploy/evenhub/` are inert templates; repository tests do
not mutate systemd, Caddy, Avahi, nftables, the hostname, or a live NanoClaw
installation.

The retained diagnostic route is fixed:

```text
G2 companion → wss://nanoclaw.local/api/even/v1/stt-stream
             → Caddy :443 → NanoClaw 127.0.0.1:18791
                                      → Moonshine 127.0.0.1:8178
             → HTTPS whole-PCM POST on any streaming failure
```

The endpoint is not an application fallback. There is no HTTP, direct-IP, WAN,
native phone helper, or cloud inference path. Caddy exposes only `/api/even/*`, disables automatic HTTP
redirects and HTTP/3, and forwards WebSocket upgrades on the same restricted
route. TCP 80 and UDP 443 must not listen.

The checked-in `deploy/evenhub/moonshine/selected-profile.json` deliberately
says `pending_physical_benchmark`. It is not passing evidence and must never be
installed as a production selected profile.

## Before installation

Use 64-bit Raspberry Pi OS, active cooling, no overclock, and a fixed private
LAN address. Record OS/kernel/architecture, cooling, G2 firmware, companion
version, LAN interface, private IPv4 subnet, and Pi address. Install Caddy,
Avahi, nftables, Node.js, and Python 3.13. Do not forward port 443 at the router.

Before changing the existing Whisper installation, capture its services,
configuration, listeners, firewall, and hashes into a new private directory:

```bash
sudo deploy/evenhub/snapshot-before-moonshine.sh \
  /var/lib/nanoclaw/private-evidence/pre-moonshine-UTC_TIMESTAMP
```

Preserve that directory and the old Whisper runtime/model as rollback evidence.
Whisper must not run concurrently with Moonshine because both own loopback port 8178.

Build and test before copying assets to the Pi:

```bash
npm ci
npm run typecheck
npm test
cd evenhub
npm ci
cp .env.private.example .env.private
chmod 0600 .env.private
# Edit .env.private with the private canonical HTTPS ts.net origin.
npm test
npm run pack:verify
npm run pack:private
sha256sum nanoclaw-evenhub-0.3.1.ehpk
```

`pack:verify` builds two packages in separate temporary paths and fails unless
their SHA-256 hashes are identical. `.ehpk` files remain ignored by git. Keep
the package private and sideload it only on the companion phone.

## Prove the Moonshine candidate

Gate 1 is mandatory before the LAN API is enabled. The installer refuses a
non-aarch64 host or existing target, creates a private Python 3.13 virtual
environment at `/opt/nanoclaw/moonshine-0.0.69`, installs only hash-locked
binary wheels, downloads official Small Streaming English model architecture 4,
and renders complete model/runtime/server/lock hashes:

```bash
sudo deploy/evenhub/moonshine/install-candidate.sh
sudo install -o root -g nanoclaw-stt -m 0640 \
  /var/lib/nanoclaw/stt/candidate-profile.json \
  /etc/nanoclaw/stt-candidate-profile.json
sudo -u nanoclaw-stt \
  /opt/nanoclaw/moonshine-0.0.69/bin/python \
  /opt/nanoclaw/moonshine-server/moonshine_server.py \
  --profile /etc/nanoclaw/stt-candidate-profile.json \
  --host 127.0.0.1 --port 8178
```

From another shell, confirm `/healthz`, then replay representative raw s16le,
16 kHz, mono PCM to `/v1/stream` in real-time 100 ms chunks. Record first
partial, stop-to-final, processing time, RTF, RSS, temperature, and both current
and historical throttling flags. Stop if Small cannot load reliably or sustain
real-time input. Do not substitute another STT family.

The daemon loads one `Transcriber`, creates an isolated Moonshine stream per
connection, validates every selected-profile component at startup, and exposes
only `/healthz`, `/v1/stream`, and `/v1/transcribe`. Its logs contain byte counts
and timing only, never audio or transcript text.

Continue with the [streaming STT benchmark](evenhub-streaming-stt-benchmark.md)
only after this runtime proof passes.

For the physical smoke and benchmark only, stage the proven candidate at the
fixed service profile path. Its `selectionStatus` remains `candidate`, so this
does not select a production model or satisfy the final evidence gate:

```bash
sudo install -o root -g nanoclaw-stt -m 0640 \
  /var/lib/nanoclaw/stt/candidate-profile.json \
  /etc/nanoclaw/stt-selected-profile.json
```

Replace this provisional file with the selector output after—and only after—a
passing complete physical benchmark.

## Select a measured profile

Start with Small Streaming. Run the complete physical protocol and manual
intent review. The fixed ladder is:

1. Small passes every gate: select Small and stop.
2. Latency-only failure: test Tiny Streaming with the complete protocol.
3. Accuracy-only failure: test Medium Streaming with the complete protocol.
4. Both dimensions fail, a candidate fails, runtime is unstable, or throttling
   cannot be avoided: block Ticket 05.

For a pass, the selector refuses incomplete gates, mismatched component hashes,
or a fabricated memory limit. It generates an owner-only selected profile and
systemd memory drop-in from the final benchmark summary:

```bash
deploy/evenhub/moonshine/select-profile.mjs \
  /var/lib/nanoclaw/stt/candidate-profile.json \
  /PRIVATE/BENCHMARK/RUN/final-summary.json \
  /tmp/stt-selected-profile.json \
  /tmp/20-measured-memory.conf
sudo install -o root -g nanoclaw-stt -m 0640 \
  /tmp/stt-selected-profile.json /etc/nanoclaw/stt-selected-profile.json
sudo install -d -o root -g root -m 0755 \
  /etc/systemd/system/nanoclaw-moonshine.service.d
sudo install -o root -g root -m 0644 \
  /tmp/20-measured-memory.conf \
  /etc/systemd/system/nanoclaw-moonshine.service.d/20-measured-memory.conf
```

Copy the generated selected profile into the tracked profile and replace the
candidate `MemoryMax` in the tracked unit only as the second evidence commit.
That commit must also record corpus, package, runtime, model, report, deployment
hashes, metrics, and the pass decision. Until physical evidence exists, leave
the tracked pending profile unchanged and do not create the evidence commit.

## Render and validate the host boundary

Install the selected profile and these assets at the exact locations:

| Repository asset                                           | Installed path                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| `deploy/evenhub/config/evenhub.env.template`               | `/etc/nanoclaw/evenhub.env` after private origin substitution |
| `deploy/evenhub/Caddyfile`                                 | `/etc/caddy/Caddyfile`                                        |
| `deploy/evenhub/avahi/nanoclaw.service`                    | `/etc/avahi/services/nanoclaw.service`                        |
| `deploy/evenhub/systemd/nanoclaw-moonshine.service`        | `/etc/systemd/system/nanoclaw-moonshine.service`              |
| `deploy/evenhub/systemd/nanoclaw-evenhub-firewall.service` | `/etc/systemd/system/nanoclaw-evenhub-firewall.service`       |
| `deploy/evenhub/systemd/nanoclaw.service.d/evenhub.conf`   | `/etc/systemd/system/nanoclaw.service.d/evenhub.conf`         |
| `deploy/evenhub/systemd/caddy.service.d/evenhub.conf`      | `/etc/systemd/system/caddy.service.d/evenhub.conf`            |
| `deploy/evenhub/systemd/nanoclaw-tailscale-serve.service`  | `/etc/systemd/system/nanoclaw-tailscale-serve.service`        |

Copy `deploy/evenhub/config/evenhub-caddy.env.template`, replace its
documentation address with the fixed Pi LAN address, and install it at
`/etc/nanoclaw/evenhub-caddy.env`. The STT endpoint is intentionally fixed in
NanoClaw at `http://127.0.0.1:8178/v1/transcribe`; do not add an inference
environment variable.

Replace the interface and example CIDR in the nftables template, then validate
all assets before loading them:

```bash
sudo nft -c -f /etc/nftables.d/nanoclaw-evenhub.nft
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemd-analyze verify \
  /etc/systemd/system/nanoclaw-moonshine.service \
  /etc/systemd/system/nanoclaw-evenhub-firewall.service \
  /etc/systemd/system/nanoclaw-tailscale-serve.service
sudo systemctl daemon-reload
```

The firewall accepts TCP 443 from the approved IPv4 LAN subnet and Tailscale
IPv4/IPv6 ingress on `tailscale0`, then denies other port 443 traffic. It also
denies direct non-loopback access to 8178 and 18791 and denies new forwarding
from the LAN while preserving established replies. The
Moonshine unit uses the dedicated `nanoclaw-stt` user, loopback-only networking,
read-only model/runtime/profile paths, private temporary storage, no privilege
escalation, restart-on-failure, and the measured memory ceiling. NanoClaw
requires Moonshine before it can accept streaming sessions.

## Start, trust, and pair

Start in dependency order only after either the proven benchmark candidate or
the final selected profile exists at `/etc/nanoclaw/stt-selected-profile.json`:

```bash
sudo systemctl enable --now nanoclaw-evenhub-firewall.service
sudo systemctl enable --now avahi-daemon.service
sudo systemctl enable --now nanoclaw-moonshine.service
sudo systemctl restart caddy.service
sudo systemctl restart nanoclaw.service
```

Caddy's local CA root is
`/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`. Transfer it
directly to the companion phone, verify its fingerprint out of band, and trust
it explicitly. A warning or changed certificate is a hard stop.

Validate the boundary from the approved LAN and from a disallowed network:

```bash
curl --fail https://nanoclaw.local/api/even/v1/healthz
curl --fail https://nanoclaw.local/api/even/v1/readyz
sudo ss -lntup
sudo nft list table inet nanoclaw_evenhub
```

Required observations: HTTPS hostname succeeds; HTTP refuses rather than
redirects; direct IP and an unapproved hostname fail certificate validation;
cellular access fails; only TCP 443 is LAN-exposed; NanoClaw and Moonshine listen
only on loopback. Caddy must pass WebSocket upgrades on `/api/even/*` and return
404 elsewhere.

Pair with `npm run evenhub:pair`, enter the one-time code, then revoke and pair
again. Run short, representative, and 30-second physical turns. Confirm immediate
`Captured · finalizing`, changing partial snapshots, a stable final transcript,
identical WhatsApp answer content, record-again, history, counters, paging, and
the 30-second automatic stop. Capture stays off during this smoke sequence.

## Restart and troubleshooting

For a routine restart:

```bash
sudo systemctl restart nanoclaw-moonshine.service
sudo systemctl restart nanoclaw.service
sudo systemctl restart caddy.service avahi-daemon.service
```

Use `journalctl -u nanoclaw-moonshine -u nanoclaw -u caddy -u avahi-daemon`
and durable turn rows as operational evidence. Search all logs and fail the
release if any bearer token, ticket, authorization header, transcript,
hypothesis, answer text, or audio bytes/content appears. Allowed fields are
event names, opaque IDs, state, sizes, timings, RSS, temperature, RTF, and
dependency status.

- `nanoclaw.local` does not resolve: inspect hostname, Avahi, UDP 5353 LAN
  policy, and the phone's LAN association.
- TLS warning: stop and re-verify `root.crt`; never bypass TLS or use HTTP.
- readiness names `stt`: inspect Moonshine health, selected hashes,
  permissions, memory ceiling, temperature, and throttling.
- readiness names `whatsapp`: verify the configured main self-chat connection.
- a streaming failure: preserve the content-free error code and verify the
  phone submitted the retained complete PCM once with the same idempotency key.
- HTTP 409: the key was reused with different audio; preserve evidence and do
  not retry a different payload under that key.

## Rollback

On any failed physical or boundary gate, first set `EVENHUB_ENABLED=false` in
`/etc/nanoclaw/evenhub.env`, restart NanoClaw, and remove the private plugin from
the phone. Stop `nanoclaw-moonshine`, preserve its journals and private evidence,
then restore the exact Whisper/NanoClaw/Caddy/systemd/nftables/hostname state
from the pre-mutation snapshot. Never run Whisper and Moonshine together on port 8178.

Do not delete SQLite rows, model/runtime files, snapshots, corpus, reports, or
logs until rollback review is complete. Re-enabling requires fresh runtime,
benchmark, hash, TLS, firewall, log-content, revoke/re-pair, and physical G2
acceptance checks.
