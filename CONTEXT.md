# NanoClaw domain language

NanoClaw uses the following terms consistently in code, tests, logs, and
documentation.

- **Turn**: one durable G2 voice request from accepted audio through a terminal
  outcome. A turn has one device owner and one idempotency key.
- **Speech transcript**: text produced by speech recognition. Live partial
  speech transcripts are display-only; the normalized final speech transcript
  is eligible to become a draft transcript.
- **Draft transcript**: the normalized final speech transcript persisted on a
  turn in `awaiting_confirmation`. It is readable but is not yet a prompt and
  must never be dispatched without an explicit `Send` decision.
- **Prompt**: the confirmed draft transcript after NanoClaw relays and stores it
  in the normal WhatsApp message path. A discarded draft never becomes a
  prompt.
- **Reply**: the exact confirmed outbound agent response stored on a completed
  turn and shown as `NanoClaw:` in the conversation feed.
- **Conversation feed**: the session-only chronological projection of `You:`
  draft/prompt entries, `NanoClaw:` replies, and durable failures. The G2 and
  companion project the same conversation, but only an unresolved draft is
  restored after relaunch.

The former use of **page** for answer chunks was ambiguous and is retired.
Reserve “page” for the EvenHub SDK `PageContainer`; conversation content uses a
wrapped-line scroll offset and is never paginated into answer pages.
