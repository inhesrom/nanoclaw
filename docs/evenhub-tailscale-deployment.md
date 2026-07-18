# EvenHub private Tailscale deployment

EvenHub 0.3.0 has one private application origin,
`https://<device>.<tailnet>.ts.net`. The concrete value is stored only in the
owner's ignored build configuration and the installed backend environment; it
must not be committed. Tailscale Serve terminates HTTPS on the Pi's tailnet
addresses and proxies only to NanoClaw's loopback API. Tailnet access controls
and the application bearer token both remain enforced. Funnel, subnet routing,
exit-node routing, and IP forwarding are not enabled.

```text
G2 companion → Tailscale on iPhone
             → wss://<device>.<tailnet>.ts.net/api/even/v1/stt-stream
             → Tailscale Serve tail addresses :443
             → NanoClaw 127.0.0.1:18791
             → Moonshine 127.0.0.1:8178

LAN diagnostics → https://nanoclaw.local/api/even/* → Caddy LAN address :443
```

Serve is private to the tailnet and respects its access controls. HTTPS
certificates publish the machine FQDN in Certificate Transparency logs; the
owner must explicitly accept that disclosure. See the
[Tailscale Serve documentation](https://tailscale.com/docs/features/tailscale-serve)
and [HTTPS certificate disclosure](https://tailscale.com/docs/how-to/set-up-https-certificates).

## Snapshot and rename

Before changing Tailscale or installed assets, create a new owner-only snapshot:

```bash
sudo deploy/evenhub/snapshot-before-tailscale.sh \
  /var/lib/nanoclaw/private-evidence/pre-tailscale-UTC_TIMESTAMP
sudo tailscale set --hostname=nanoclaw
sudo tailscale status --json
```

Confirm the self DNS name is `<device>.<tailnet>.ts.net.` and the phone remains
in the same personal tailnet. Preserve the snapshot for rollback; do not copy
its private JSON or configuration into the repository.

## Enable HTTPS in the tailnet

In the Tailscale admin console DNS page, enable HTTPS certificates and accept
the public-ledger disclosure. Do this only after the rename; obtaining a
certificate for `pi5-0` would permanently publish the old name. MagicDNS must
remain enabled. Do not enable Funnel.

## Build the private client

```bash
cd evenhub
npm ci
cp .env.private.example .env.private
chmod 0600 .env.private
# Edit .env.private with the concrete canonical HTTPS ts.net origin.
npm test
npm run pack:verify
npm run pack:private
sha256sum nanoclaw-evenhub-0.3.0.ehpk
```

The private packer requires mode `0600`, validates a canonical HTTPS `ts.net`
origin, injects it into the client, and renders a temporary manifest with only
the corresponding HTTPS and WSS whitelist entries. The generated manifest and
`.ehpk` remain ignored. The package ID remains
`dev.inhesrom.nanoclaw.evenhub`, so upgrading preserves the companion's stored
bearer token. On launch, `/readyz` must succeed before recording is enabled; a
network failure shows `Connect Tailscale and retry.`

## Install and validate the boundary

Render the existing nftables template with the real LAN interface and subnet.
Install the updated environment, firewall policy, and Serve service:

```bash
sudo install -o root -g root -m 0600 deploy/evenhub/config/evenhub.env.template \
  /etc/nanoclaw/evenhub.env
# Before restarting, replace REPLACE_WITH_TAILSCALE_HTTPS_ORIGIN in the
# installed file with the same origin used by evenhub/.env.private.
sudoedit /etc/nanoclaw/evenhub.env
sudo install -o root -g root -m 0644 \
  deploy/evenhub/systemd/nanoclaw-evenhub-firewall.service \
  /etc/systemd/system/nanoclaw-evenhub-firewall.service
sudo install -o root -g root -m 0644 \
  deploy/evenhub/systemd/nanoclaw-tailscale-serve.service \
  /etc/systemd/system/nanoclaw-tailscale-serve.service
sudo nft -c -f /etc/nftables.d/nanoclaw-evenhub.nft
sudo systemd-analyze verify \
  /etc/systemd/system/nanoclaw-evenhub-firewall.service \
  /etc/systemd/system/nanoclaw-moonshine.service \
  /etc/systemd/system/nanoclaw-tailscale-serve.service
```

The policy admits self-checks on loopback plus Tailscale IPv4 and IPv6 port 443
traffic on `tailscale0` before the catch-all port 443 denial. Caddy remains
bound only to the fixed LAN address. NanoClaw and Moonshine remain on loopback,
and non-loopback direct access to 18791 and 8178 is denied.

Confirm Funnel has no public listener before loading Serve:

```bash
sudo tailscale funnel status
sudo systemctl daemon-reload
sudo systemctl restart nanoclaw-evenhub-firewall.service
sudo systemctl restart nanoclaw.service
sudo systemctl enable --now nanoclaw-tailscale-serve.service
```

Before Serve is configured, Funnel status is empty. With Tailscale 1.98, both
human status commands display the shared active configuration after Serve is
configured; it must say `(tailnet only)`, never `Available on the internet`.
The oneshot unit uses `tailscale serve --bg`, which persists across tailscaled
and host restarts, and proxies only to `http://127.0.0.1:18791`. Stopping the
unit removes its HTTPS listener.

## Validation

From a connected tailnet device, require valid HTTPS health/readiness and a
WebSocket upgrade through `<device>.<tailnet>.ts.net`. HTTP, direct tail-IP TLS,
an unapproved hostname, and a non-tailnet device must fail. With Tailscale off
on the phone, launch must fail before recording with the actionable retry state.

```bash
EVENHUB_FQDN=device.tailnet.ts.net
curl --fail "https://${EVENHUB_FQDN}/api/even/v1/healthz"
curl --fail "https://${EVENHUB_FQDN}/api/even/v1/readyz"
sudo tailscale serve status --json
sudo tailscale funnel status
sudo ss -lntup
sudo nft list table inet nanoclaw_evenhub
```

Required observations:

- Serve owns port 443 only on the Pi's Tailscale IPv4/IPv6 addresses.
- Caddy still owns port 443 only on the approved LAN address.
- 18791 and 8178 listen only on `127.0.0.1`.
- Funnel status identifies the configuration as `tailnet only`, and router
  forwarding is unchanged.
- The LAN diagnostic health/readiness endpoint still works from the approved LAN.
- Caddy, NanoClaw, Moonshine, and tailscaled logs contain no bearer tokens,
  tickets, audio, transcripts, hypotheses, or answer text.
- `git grep -E 'EVENHUB_ORIGIN=https://|[.]ts[.]net'` finds only the public
  documentation fixture and placeholders, never the owner's concrete tailnet
  suffix.

Run short, representative, and automatic 30-second physical turns with
Tailscale enabled on both Wi-Fi and cellular. Confirm partials,
`Captured · finalizing`, final transcript, WhatsApp delivery, history, paging,
and record-again. Then disconnect Tailscale mid-recording, reconnect, and retry;
the retained PCM and idempotency key must produce at most one durable turn and
one WhatsApp dispatch.

## Rollback

Preserve all evidence. Stop `nanoclaw-tailscale-serve.service`, restore the
environment, firewall, hostname, and units from the pre-Tailscale snapshot,
then restart the firewall and NanoClaw. Reinstall the prior private package only
if application rollback is required. Do not delete turns, model/runtime files,
snapshots, logs, or the retained LAN Caddy configuration.
