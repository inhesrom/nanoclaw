# NanoClaw EvenHub plugin

Private LAN voice bridge for Even G2. Tap once to record PCM s16le at 16 kHz
mono, tap again to send it to NanoClaw, and page through the reply on the
glasses.

## Development

1. Set `VITE_EVENHUB_ORIGIN` in `.env.local` if the host is not
   `https://nanoclaw.local`.
2. From the repository root, enable the host with `EVENHUB_ENABLED=true`.
3. Run `npm run evenhub:pair` at the repository root and enter the one-time code
   in the plugin companion screen.
4. In this directory, run `npm install`, `npm run dev`, then
   `npm run simulate`.

The production host sends accepted recordings to a single FIFO local Whisper
worker. See [the host setup](../docs/evenhub-local-whisper.md) for the pinned
runtime, checksum verification, and loopback command. WhatsApp/NanoClaw
dispatch uses the [durable turn lifecycle](../docs/evenhub-turn-lifecycle.md).
