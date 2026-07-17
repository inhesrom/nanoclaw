# EvenHub streaming STT protocol v1

The external protocol is authenticated in two steps. The paired companion first
creates a 60-second ticket with bearer-authenticated
`POST /api/even/v1/stt-sessions`, sending its turn UUIDv4 as
`{"idempotencyKey":"..."}`. The response contains `sessionId`, a random ticket,
expiry, protocol version, and the fixed audio limits. Only the SHA-256 of the
ticket is held in memory.

The companion then opens `wss://nanoclaw.local/api/even/v1/stt-stream`. The URL
contains no credential. The WebSocket Origin must be exactly
`https://nanoclaw.local` or the installed EvenHub WebView's observed,
per-launch `http://127.0.0.1:<ephemeral-port>` origin. The loopback form accepts
only canonical numeric ports 49152–65535; other hosts, schemes, ports, paths,
missing origins, and lookalikes are rejected. The first message within five
seconds must be:

```json
{
  "type": "start",
  "version": 1,
  "session": "session ID",
  "ticket": "single-use ticket",
  "format": {
    "encoding": "s16le",
    "sampleRate": 16000,
    "channels": 1
  }
}
```

After `{"type":"ready","version":1}`, every binary message is a four-byte
big-endian sequence followed by an even, nonempty PCM payload. Sequence starts
at zero and has no gaps or duplicates. The client retains all PCM locally while
streaming it.

Transcript feedback is a complete snapshot, never a delta:

```json
{
  "type": "snapshot",
  "finalText": "stable prefix",
  "interimText": "mutable suffix"
}
```

The server emits changed snapshots at most once per 500 ms. Partial text is
display-only and is not inserted into the turn database or turn history.

Stop freezes the glasses timer immediately. The client calculates SHA-256 over
the complete retained PCM and sends:

```json
{
  "type": "finish",
  "nextSequence": 12,
  "durationMs": 2750,
  "sha256": "64 lowercase hexadecimal characters"
}
```

After validating order, byte count, duration, hash, and a nonempty Moonshine
final, the server durably finalizes the ordinary turn and sends
`{"type":"final", ...}` using the existing public turn envelope. The phone then
polls that same turn for the NanoClaw/WhatsApp answer.

Errors have only a stable code, retryability, and the content-free message
`Streaming session rejected`. Tokens, tickets, audio, transcripts, hypotheses,
and answers are forbidden from logs.

Limits are 30 seconds/960,000 PCM bytes, one active stream per device, two
globally, and 256 KiB client/server backpressure. Tickets are single-use;
expired, replayed, revoked, malformed, and missing tickets fail without retained
audio. Format changes, odd PCM, sequence errors, oversize streams, invalid
finish metadata, slow consumers, and disconnect before finish delete the
owner-only `.part` file and create no database turn.

If connection setup, backpressure, streaming, or the final response fails, the
phone posts its complete retained PCM to `POST /api/even/v1/turns` with the same
idempotency key. A lost response after streaming commit therefore replays the
existing turn through the ordinary hash/idempotency check, producing at most one
turn and one WhatsApp dispatch.
