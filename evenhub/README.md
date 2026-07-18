# NanoClaw EvenHub plugin

Private Tailscale voice bridge for Even G2. Tap once to stream retained PCM
s16le at 16 kHz mono to local Moonshine and tap again to stop. Review the
complete draft transcript, then explicitly choose `Send` or `Try again` on the
G2 or companion. Replies join a continuous, four-lines-per-swipe conversation
feed instead of answer pages. A streaming failure submits the same complete PCM
with the same idempotency key through the tailnet API and still stops for
confirmation.

See the [changelog](CHANGELOG.md) for release notes.

## Development

1. Copy `.env.private.example` to `.env.private`, set its canonical
   `https://<device>.<tailnet>.ts.net` origin, and set mode `0600`. The ignored
   value is compiled into the client and rendered into its exact HTTPS/WSS
   manifest whitelist; the app does not fall back to `nanoclaw.local`.
2. From the repository root, enable the host with the reviewed EvenHub
   environment rendered from `deploy/evenhub/config/evenhub.env.template`.
3. Run `npm run evenhub:pair` at the repository root and enter the one-time code
   in the plugin companion screen.
4. In this directory, run `npm install`, `npm run dev`, then
   `npm run simulate`.

The production host authenticates a short-lived, single-use WebSocket ticket,
streams to a persistent loopback Moonshine service, and commits only a valid
finish plus nonempty final transcript. PCM is removed after that transcript is
persisted as `awaiting_confirmation`; only `Send` wakes WhatsApp. Dispatch uses the
[durable turn lifecycle](../docs/evenhub-turn-lifecycle.md). The complete Pi
runtime, TLS, firewall, packaging, and rollback procedure is in the
[Tailscale deployment guide](../docs/evenhub-tailscale-deployment.md); the
retained diagnostic endpoint is covered by the
[LAN deployment guide](../docs/evenhub-lan-deployment.md). Wire messages and
failure semantics are in the
[streaming protocol](../docs/evenhub-streaming-protocol.md).

Protocol 2 requires host and plugin version 0.4.0 together. Older clients receive
`426 client_upgrade_required` before audio is accepted.
