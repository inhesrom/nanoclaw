# EvenHub Whisper rollback snapshot

Whisper is no longer the production STT service. Preserve the prior
`whisper.cpp` `v1.9.1` runtime, `base.en` model, unit/configuration snapshot, and
benchmark reports for rollback only. Never run it concurrently with Moonshine;
both use loopback port 8178.

The historical verified inputs are:

- whisper.cpp v1.9.1 arm64 archive SHA-256:
  `e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3`
- `ggml-base.en.bin` SHA-1:
  `137c40403d78fd54d454da0f9bd998f78703390c`

They can still be checked with:

```bash
npm run evenhub:whisper:verify -- \
  /path/to/whisper-v1.9.1-arm64-archive \
  /var/lib/nanoclaw/whisper/ggml-base.en.bin
```

The old loopback command, whole-WAV request path, and version-1 benchmark remain
historical compatibility surfaces, not release acceptance. Restore them only
through the reviewed pre-Moonshine snapshot after disabling EvenHub and stopping
Moonshine. See the [LAN rollback procedure](evenhub-lan-deployment.md#rollback).
