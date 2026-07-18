# EvenHub physical G2 streaming STT benchmark

This is the hardware acceptance gate for Ticket 05. PCM, references,
hypotheses, intent notes, and reports are private operator evidence. Keep them
outside the git worktree with directories mode `0700` and files mode `0600`.
There is no cloud inference fallback.

## Smoke before capture

With capture off, run short, representative, and 30-second physical G2 turns.
Verify tap-to-stop, changed partial snapshots, stable complete draft review,
four-line feed scrolling, both confirmation decisions, no dispatch before
`Send`, replacement recording after acknowledged discard, conversation history,
relaunch restoration, and automatic stop. Fix smoke failures before arming the
corpus.

## Capture the authoritative corpus

Create a new private directory and arm exactly 30 successful physical turns:

```bash
benchmark_dir=/var/lib/nanoclaw/private-evidence/g2-UTC_TIMESTAMP
install -d -m 0700 "$benchmark_dir"
npm run evenhub:benchmark -- capture arm --output "$benchmark_dir" --count 30
npm run evenhub:benchmark -- capture status
```

Capture is off by default. A successful streaming turn is copied once before
ordinary PCM cleanup. Copy/index failure disarms capture without failing the
turn. An incomplete session is not authoritative; disarm it and begin with a
new empty directory. After 30 files, confirm capture automatically disarmed and
make one ordinary turn to confirm normal cleanup resumed.

Record ten 1–5 second, ten 6–15 second, and ten 16–30 second utterances. Each
band needs at least three quiet, three TV/conversation, three outdoor/fan, and
one free-choice sample. At least ten samples must contain a proper noun, date,
number, or punctuation-sensitive request.

## Version-2 manifest

Create owner-only `$benchmark_dir/manifest.json`. It contains exactly 30
samples and provider-neutral STT metadata:

```json
{
  "version": 2,
  "sessionId": "2026-07-17T17-00-00Z",
  "createdAt": "2026-07-17T17:00:00.000Z",
  "environment": {
    "g2Firmware": "...",
    "evenHubApp": "0.2.1",
    "phone": "model / OS / companion version",
    "pi": "Pi 5 / OS / kernel / aarch64 / cooling"
  },
  "stt": {
    "provider": "moonshine",
    "streamingProtocol": "moonshine-stream-v1",
    "serviceEndpoint": "http://127.0.0.1:8178",
    "modelId": "moonshine-streaming-small-en",
    "modelArchitecture": "small-streaming",
    "modelPath": "/var/lib/nanoclaw/stt/moonshine-streaming-small-en",
    "runtimePath": "/opt/nanoclaw/moonshine-0.0.69",
    "modelComponents": ["eight absolute component paths"],
    "runtimeComponents": ["all absolute native library and RECORD paths"],
    "lockfilePath": "/opt/nanoclaw/moonshine-server/requirements-aarch64-py313.lock",
    "serverPath": "/opt/nanoclaw/moonshine-server/moonshine_server.py",
    "updateIntervalMs": 500
  },
  "samples": [
    {
      "id": "short-01",
      "pcmPath": "/absolute/private/path/01.pcm",
      "sha256": "64 lowercase hexadecimal characters",
      "reference": "Human reference transcript",
      "intent": "Meaning that every hypothesis must retain",
      "durationMs": 3200,
      "noise": "quiet",
      "challengeTerms": true
    }
  ],
  "corpusSha256": "64 lowercase hexadecimal characters"
}
```

Allowed noise values are `quiet`, `tv_conversation`, `outdoor_fan`, and
`free_choice`. The aggregate digest is SHA-256 over each manifest-ordered sample
ID, NUL byte, lowercase PCM SHA-256, and newline. The runner independently
checks PCM hashes, byte/duration agreement, distribution, environment,
component existence, and aggregate digest.

## Run from a clean thermal state

Reboot before each candidate. Record 64-bit architecture, cooling/no overclock,
selected component hashes, empty prior throttling history, and service
readiness. Then run exactly five deterministic serial trials:

```bash
npm run evenhub:benchmark -- run \
  --manifest "$benchmark_dir/manifest.json" --runs 5 --seed 20260717
```

The runner performs one discarded real-time warm-up, then 150 inferences in
five seeded Fisher–Yates orders. Every PCM file is replayed in real-time 100 ms
chunks through `/v1/stream`. Owner-only results record time to first nonempty
partial, stop-to-final, model processing time, RTF, partial revision count,
final hypothesis/WER counts, PCM/model/runtime/lock/server hashes, RSS,
temperature, and current/historical throttling.

Missing metrics fail closed. Automated gates are aggregate normalized WER at
most 15%, stop-to-final p95 at most 1.0 second and maximum at most 2.0 seconds,
no current or historical throttling, all required metrics, and a complete
five-run protocol.

## Manual intent and finalization

Read every hypothesis and create an owner-only version-2 review. An utterance
passes only when all five hypotheses preserve its requested meaning:

```json
{
  "version": 2,
  "reviewer": "operator name",
  "reviewedAt": "2026-07-17T20:00:00.000Z",
  "samples": [
    {
      "sampleId": "short-01",
      "judgments": [true, true, true, true, true],
      "notes": "optional private note"
    }
  ]
}
```

```bash
npm run evenhub:benchmark -- finalize \
  --run-dir "$benchmark_dir/run-..." \
  --intent-review "$benchmark_dir/intent-review.json"
```

Finalization replays ordering/WER calculations, verifies every detailed metric
and component hash, requires exactly five judgments for each unique sample, and
passes intent only at 28/30 or better. A passing summary recommends
`MemoryMax=ceil(peak RSS × 1.25)` MiB. Use the selection ladder and profile
selector in the [LAN deployment runbook](evenhub-lan-deployment.md). A block is
an honest Ticket 05 outcome; do not weaken gates or silently change STT family.
