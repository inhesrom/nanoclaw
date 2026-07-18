# EvenHub streaming STT protocol v2

EvenHub 0.4.0 requires `X-EvenHub-Protocol-Version: 2` on readiness and every
authenticated STT/turn request. Missing or older versions receive
`426 client_upgrade_required`; `/healthz` and pairing remain exempt. Host and
plugin are released together and protocol 2 has no immediate-dispatch fallback.

The paired companion creates a 60-second, single-use ticket with
`POST /api/even/v1/stt-sessions`, its bearer token, the protocol header, and
`{"idempotencyKey":"<UUIDv4>"}`. The response contains session ID, random
ticket, expiry, protocol version 2, and fixed audio limits. Only the ticket hash
is retained in memory.

The client then opens
`wss://<device>.<tailnet>.ts.net/api/even/v1/stt-stream`. The URL contains no
credential. Origin must match the compiled private origin or the installed
EvenHub WebView's canonical `http://127.0.0.1:<49152-65535>` origin. The first
message within five seconds is:

```json
{
  "type": "start",
  "version": 2,
  "session": "session ID",
  "ticket": "single-use ticket",
  "format": { "encoding": "s16le", "sampleRate": 16000, "channels": 1 }
}
```

After `{"type":"ready","version":2}`, every binary message is a four-byte
big-endian sequence followed by an even, nonempty PCM payload. Sequence starts
at zero with no gaps or duplicates. The client retains complete PCM until final
commit. Snapshot messages contain complete `finalText` and `interimText`, never
deltas; the host emits changed snapshots at most every 500 ms and never stores
partials.

Tap-to-stop freezes the timer immediately. The client sends `finish` with next
sequence, integer duration, and SHA-256 of the retained PCM. After validating
order, bytes, duration, hash, and a nonempty Moonshine result, the host persists
the normalized draft as `awaiting_confirmation`, deletes PCM, and returns the
public turn envelope. It does not wake WhatsApp. The client stops polling and
shows the complete draft until explicit confirmation.

Limits remain 30 seconds/960,000 PCM bytes, one active stream per device, two
globally, and 256 KiB backpressure. Ticket, format, sequence, size, finish, and
disconnect failures delete the owner-only partial file and create no turn.

If streaming setup or final response fails, the client posts the complete PCM
to `POST /api/even/v1/turns` with the same idempotency key and protocol header.
That fallback also stops at `awaiting_confirmation`. Network failure retains the
draft or PCM safely; it never sends, changes origin, or infers confirmation.
Tokens, tickets, audio, drafts, prompts, hypotheses, and replies are forbidden
from logs.
