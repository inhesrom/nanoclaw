# EvenHub physical G2 Whisper benchmark

This procedure is the hardware acceptance gate for ticket 05. Raw PCM,
references, hypotheses, intent notes, and reports are private operator evidence;
keep them outside the repository with owner-only permissions. There is no cloud
transcription fallback.

## Create and capture a session

Create an empty UTC-named directory on the Pi, then explicitly arm capture:

```bash
session="$HOME/nanoclaw-evenhub-benchmarks/$(date -u +%Y-%m-%dT%H-%M-%SZ)"
install -d -m 0700 "$session"
npm run evenhub:benchmark -- capture arm --output "$session" --count 30
npm run evenhub:benchmark -- capture status
```

Only validated physical G2 PCM is copied. The normal turn still proceeds through
Whisper and the WhatsApp main self-chat. The capture index and PCM files use mode
`0600`; capture automatically disarms at 30. A copy/index failure also disarms
capture without logging audio or transcript content and does not fail the turn.
Discard the whole incomplete directory and begin with a new empty session.

Record exactly ten 1–5 second, ten 6–15 second, and ten 16–30 second samples.
Within every duration band record three quiet, three TV/conversation, three
outdoor/fan, and one free-choice sample. At least ten of the 30 must exercise a
proper noun, date, number, or punctuation-sensitive request.

Use `capture disarm` for an operator abort. After capture, confirm `armed` is
false and make one ordinary turn; its PCM must resume normal cleanup.

## Manifest contract

Create `$session/manifest.json` with mode `0600`. It has this shape (all 30
sample objects are required):

```json
{
  "version": 1,
  "sessionId": "2026-07-16T22-00-00Z",
  "createdAt": "2026-07-16T22:00:00.000Z",
  "environment": {
    "g2Firmware": "...",
    "evenHubApp": "0.1.0",
    "phone": "model / OS / companion version",
    "pi": "model / OS / kernel / architecture / cooling",
    "whisperCpp": "v1.9.1 release arm64"
  },
  "whisper": {
    "endpoint": "http://127.0.0.1:8178/inference",
    "modelId": "base.en",
    "modelPath": "/var/lib/nanoclaw/whisper/ggml-base.en.bin",
    "binaryPath": "/usr/local/bin/whisper-server",
    "threads": 4,
    "processors": 1
  },
  "samples": [
    {
      "id": "short-01",
      "pcmPath": "/home/operator/nanoclaw-evenhub-benchmarks/.../01.pcm",
      "sha256": "64 lowercase hexadecimal characters",
      "reference": "Human reference transcript",
      "intent": "What meaning the request must retain",
      "durationMs": 3200,
      "noise": "quiet",
      "challengeTerms": true
    }
  ],
  "corpusSha256": "64 lowercase hexadecimal characters"
}
```

Allowed noise values are `quiet`, `tv_conversation`, `outdoor_fan`, and
`free_choice`. The aggregate digest is SHA-256 over each manifest-ordered
`id`, a NUL byte, its lowercase PCM SHA-256, and a newline. `run` independently
checks every PCM hash, duration/byte relationship (s16le, 16 kHz, mono), corpus
distribution, reference, intent, environment field, and aggregate digest.

## Run the clean Pi gate

Before every candidate, reboot and record evidence that the host is 64-bit, the
release binary is selected, active cooling is working, no overclock is present,
the service has `--threads 4 --processors 1`, the artifact hashes match, and
`vcgencmd get_throttled` is exactly `0x0`.

```bash
npm run evenhub:benchmark -- run \
  --manifest "$session/manifest.json" --runs 5 --seed 20260716
```

The command performs one discarded warm-up, then 150 serial loopback inferences
in five deterministic Fisher–Yates orders. It creates an owner-only `run-*`
directory beside the manifest containing `results.jsonl`, `run-summary.json`,
and `run-summary.md`. Results include the hypothesis, normalized WER counts,
latency, RTF, PCM/model/binary hashes, peak observed RSS and CPU temperature,
and current/historical Pi throttling flags. WER normalization lowercases,
trims, replaces Unicode punctuation with spaces, and collapses whitespace; it
does not rewrite names, words, or numbers.

## Review intent and finalize

Read all five hypotheses for each utterance and create an owner-only intent
review. A single `false` means that utterance failed intent:

```json
{
  "version": 1,
  "reviewer": "operator name",
  "reviewedAt": "2026-07-16T23:00:00.000Z",
  "samples": [
    {
      "sampleId": "short-01",
      "judgments": [true, true, true, true, true],
      "notes": "optional private review note"
    }
  ]
}
```

```bash
npm run evenhub:benchmark -- finalize \
  --run-dir "$session/run-..." \
  --intent-review "$session/intent-review.json"
```

Finalization passes only with aggregate WER at most 15%, at least 28/30 intent
passes, p95 latency at most 4 seconds, maximum latency at most 8 seconds, no
current or historical throttling, all required metrics, and exactly 150
measurements. It writes final JSON/Markdown evidence and recommends
`MemoryMax=ceil(peak RSS × 1.25)` MiB only for a passing model.

Start with `ggml-base.en.bin`. A latency-only failure may test
`ggml-base.en-q5_1.bin` (SHA-1
`d26d7ce5a1b6e57bea5d0431b9c20ae49423c94a`, SHA-256
`4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f`). An
accuracy-only failure may test `ggml-small.en.bin` (SHA-1
`db8a495a91d927739e50b3fc1cc4c6b8f6c2d022`). Use the complete protocol for
each candidate. Failure in both dimensions, candidate failure, or uncorrectable
throttling blocks rollout; do not change the product contract or add cloud STT.

For a pass, install the measured `MemoryMax`, pin the selected model path and
checksum in the deployment bundle, restart Whisper then NanoClaw, and reconfirm
readiness plus one physical G2 turn. Attach only artifact/model/corpus/report
hashes, the metric summary, measured limit, environment, and pass/block decision
to ticket 05. Detailed evidence remains in the private session directory.
