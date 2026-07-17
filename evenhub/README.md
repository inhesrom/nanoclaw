# NanoClaw EvenHub plugin

Private LAN voice bridge for Even G2. Tap once to stream retained PCM s16le at
16 kHz mono to local Moonshine, tap again to finalize, and page through the
NanoClaw reply on the glasses. Any streaming or final-response failure sends the
same complete PCM once through the existing local fallback.

## Development

1. Use the pinned `https://nanoclaw.local` origin. Other origins are rejected.
2. From the repository root, enable the host with the reviewed EvenHub
   environment in `deploy/evenhub/config/evenhub.env`.
3. Run `npm run evenhub:pair` at the repository root and enter the one-time code
   in the plugin companion screen.
4. In this directory, run `npm install`, `npm run dev`, then
   `npm run simulate`.

The production host authenticates a short-lived, single-use WebSocket ticket,
streams to a persistent loopback Moonshine service, and commits only a valid
finish plus nonempty final transcript. WhatsApp/NanoClaw dispatch uses the
[durable turn lifecycle](../docs/evenhub-turn-lifecycle.md). The complete Pi
runtime, benchmark, TLS, firewall, packaging, and rollback procedure is in the
[LAN deployment guide](../docs/evenhub-lan-deployment.md); wire messages and
failure semantics are in the
[streaming protocol](../docs/evenhub-streaming-protocol.md).
