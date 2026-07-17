# EvenHub local Whisper runtime

The EvenHub host uses `whisper.cpp` `v1.9.1` with the unquantized English
`base.en` model. The runtime is a separate loopback-only process; NanoClaw owns
PCM validation, WAV framing, FIFO retries, and durable transcript storage.

## Pinned assets

Before installing either downloaded asset, verify the official arm64 release
archive and model together:

```bash
npm run evenhub:whisper:verify -- \
  /path/to/whisper-v1.9.1-arm64-archive \
  /var/lib/nanoclaw/whisper/ggml-base.en.bin
```

The verifier requires these published digests:

- `whisper.cpp` v1.9.1 arm64 archive SHA-256:
  `e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3`
- `ggml-base.en.bin` SHA-1:
  `137c40403d78fd54d454da0f9bd998f78703390c`

Do not enable the host if verification fails. The first Pi target is a 64-bit
OS with active cooling and no overclock.

## Runtime command

Start the verified binary with the model preloaded:

```bash
whisper-server \
  --model /var/lib/nanoclaw/whisper/ggml-base.en.bin \
  --host 127.0.0.1 --port 8178 \
  --threads 4 --processors 1 \
  --language en --no-timestamps --no-context
```

NanoClaw defaults `EVENHUB_WHISPER_URL` to
`http://127.0.0.1:8178/inference`. Each request is a canonical 16-bit,
16 kHz, mono WAV multipart upload with JSON output, temperature `0.0`, an empty
prompt, and `carry_initial_prompt=false`.

Only one inference runs at a time. Transport and 5xx failures are retried once
after one second. The durable turn becomes `stt_unavailable` after exhaustion,
`stt_unintelligible` for empty speech, or `invalid_audio` for malformed input.
Raw PCM is removed only after the transcript or terminal STT failure is stored.

## Local verification

```bash
npm run typecheck
npx vitest run src/evenhub/wav.test.ts \
  src/evenhub/whisper-client.test.ts \
  src/evenhub/whisper-worker.test.ts \
  src/evenhub/whisper-assets.test.ts \
  src/evenhub/server.test.ts
```

Tests use synthetic PCM and a fake loopback response. The physical G2 corpus,
Pi latency/accuracy gate, and throttling check remain hardware rollout work.
