# ADR 0001: Confirm draft transcripts before dispatch

- Status: Accepted
- Date: 2026-07-18
- Release: EvenHub 0.4.0 / protocol 2

## Context

Speech recognition can produce a plausible but materially wrong transcript.
Before 0.4.0, both streaming and fallback transcription advanced immediately
to WhatsApp dispatch. The user could see the recognized text but had no safe
boundary at which to stop it from becoming a prompt.

## Decision

Both STT paths normalize and persist the final speech transcript as a draft in
`awaiting_confirmation`, delete retained PCM, and stop. Either the G2 or the
companion may resolve the draft with `Send` or `Try again`; an atomic
compare-and-set makes the first decision win. `Send` advances to `dispatching`.
`Try again` advances to terminal `discarded`, and replacement recording starts
only after that acknowledgement. Timeouts, restarts, and network failures never
imply consent.

The G2 and companion show the draft in a continuous session conversation feed.
Only unresolved draft identity is durable client state; completed feed history
is intentionally session-only.

## Consequences

Every successful voice turn now needs an additional deliberate action, adding
latency and one interaction. In return, the dispatch boundary is explicit,
auditable without logging content, restart-safe, and race-safe across both
surfaces. Drafts remain readable for the seven-day turn retention window and
then expire. Host and plugin must be upgraded together because protocol 2 does
not retain immediate-dispatch compatibility.

Exact hold-to-talk is out of scope for a public plugin. Public plugins receive
completed click/swipe events rather than a press-down/release pair, and the
normal G2 one-second hold opens the system menu. Even Realities documents
hold-to-talk for its dedicated [Terminal Mode](https://www.evenrealities.com/en-GB/terminal),
while the [developer overview](https://hub.evenrealities.com/docs) defines the
public plugin surface and the [G2 control guide](https://support.evenrealities.com/hc/en-us/articles/13754911116047-How-to-Control)
assigns press-and-hold to Menu. NanoClaw therefore uses tap-to-start and
tap-to-stop.
