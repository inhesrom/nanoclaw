# EvenHub changelog

## 0.4.0

- Require protocol 2 across the host and plugin so an outdated client fails
  closed before audio is accepted.
- Hold completed transcripts in a durable `awaiting_confirmation` state until
  the wearer explicitly chooses `Send` or `Try again`.
- Preserve exactly-once dispatch and discard semantics across retries,
  reconnects, and app relaunches.
- Replace reply paging with a continuous session conversation feed that keeps
  spoken prompts, replies, failures, and the unresolved draft in context.
- Keep streaming and fallback transcription aligned: both persist the same
  reviewable final draft and never wake WhatsApp before confirmation.
