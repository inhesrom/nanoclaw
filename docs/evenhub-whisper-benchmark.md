# Historical EvenHub Whisper benchmark

This version-1 benchmark contract is retained only so existing private Whisper
reports remain readable. Whisper is now a rollback snapshot, not a concurrent
or selected production inference service.

`npm run evenhub:benchmark -- run` and `finalize` continue to detect version-1
manifests and summaries. Do not use the old 4-second p95/8-second maximum gates
to accept Ticket 05. New physical acceptance must use a version-2 manifest and
the [Moonshine streaming benchmark](evenhub-streaming-stt-benchmark.md).

The historical pinned runtime and checksums remain documented in
[EvenHub local Whisper runtime](evenhub-local-whisper.md). Preserve its private
corpus, references, hypotheses, intent notes, and reports outside git with
owner-only permissions.
