# EvenHub changelog

## 0.4.2

- Add a proportional eight-row scrollbar beside the G2 conversation feed while
  preserving contextual arrow hints and status-only thinking updates.
- Add a persistent multiline phone composer with exact Unicode text delivery,
  a 2,000-code-point limit, immediate `You` feedback, and idempotent retry.
- Advertise voice and text capabilities independently so typed messages remain
  available when speech recognition is down and unavailable voice cannot open
  the G2 microphone.
- Store typed prompts as durable, directly dispatching text turns without audio
  files or voice confirmation while retaining the shared reply lifecycle.

## 0.4.1

- Open the G2 confirmation strip automatically only after the host returns the
  complete final transcript, with `Send` selected by default.
- Use sentence-case recording and transcription copy, contextual scroll arrows,
  and a restrained four-frame `Thinking` status animation.
- Add a rounded outer display frame and keep gesture capture on the status dock
  while leaving the feed free of capture metadata.
- Update only the changed G2 text container so thinking frames do not resend an
  unchanged transcript over BLE.

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
