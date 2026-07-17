# NanoClaw EvenHub plugin

Private LAN voice bridge for Even G2. Tap once to record PCM s16le at 16 kHz
mono, tap again to send it to NanoClaw, and page through the reply on the
glasses.

## Development

1. Use the pinned `https://nanoclaw.local` origin. Other origins are rejected.
2. From the repository root, enable the host with the reviewed EvenHub
   environment in `deploy/evenhub/config/evenhub.env`.
3. Run `npm run evenhub:pair` at the repository root and enter the one-time code
   in the plugin companion screen.
4. In this directory, run `npm install`, `npm run dev`, then
   `npm run simulate`.

The production host sends accepted recordings to a single FIFO local Whisper
worker. See [the host setup](../docs/evenhub-local-whisper.md) for the pinned
runtime, checksum verification, and loopback command. WhatsApp/NanoClaw
dispatch uses the [durable turn lifecycle](../docs/evenhub-turn-lifecycle.md).
The complete Pi service, TLS, firewall, private packaging, and rollback runbook
is in [the LAN deployment guide](../docs/evenhub-lan-deployment.md).
