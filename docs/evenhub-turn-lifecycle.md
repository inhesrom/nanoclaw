# EvenHub confirmed turn lifecycle

EvenHub 0.4.1 uses one durable lifecycle:

```text
recording → transcribing → awaiting_confirmation
                               ├─ Send → dispatching → queued → running → completed
                               └─ Try again → discarded
```

`failed` is terminal from transcription, dispatch, queue, or agent execution.
Live partial speech transcripts are display-only. Streaming and fallback STT
persist the normalized final text as a draft transcript in
`awaiting_confirmation`, delete PCM, and stop. A timeout, restart, lost
response, or network failure never advances the turn.

## Confirmation boundary

Paired protocol-2 clients resolve a device-owned turn with:

```http
POST /api/even/v1/turns/:turnId/confirmation
Authorization: Bearer <device token>
X-EvenHub-Protocol-Version: 2
Content-Type: application/json

{ "decision": "send" }
```

The decision is `send` or `discard`. The host atomically records the decision
and changes `awaiting_confirmation` to `dispatching` or `discarded`. Repeating
the same decision returns `200`; a conflicting or late decision returns
`409 turn_already_resolved`. A turn owned by another device returns `404`, under
the existing bearer-token rules. The first decision from the G2 or companion
wins.

## Prompt correlation

Only a confirmed `send` wakes the WhatsApp bridge. The coordinator processes
one G2 prompt at a time:

1. Reserve a Baileys-compatible message ID while the turn is `dispatching`.
2. Send the draft transcript to the registered WhatsApp self-chat with that ID.
3. Store the confirmed message with a host-only `even_turn_id`; never put a
   correlation marker in visible text.
4. Compare-and-set to `queued`; the normal message loop marks it `running` when
   agent processing starts.

If the local prompt was stored before restart, reconciliation can finish
`dispatching → queued` without another relay. A reserved ID without a stored
prompt is ambiguous and fails closed rather than risking a duplicate prompt.

## Reply and feed boundary

After a confirmed WhatsApp send, NanoClaw stores the exact outbound Unicode
string as the Reply and moves `running → completed`. The G2 and companion place
that same string after the preceding `You:` entry in their continuous
conversation feed. They keep completed and failed turns for the current app
session; only an unresolved draft is restored after relaunch.

Logs contain IDs, states, timings, and lengths, never audio, draft transcripts,
prompts, or replies.

## Retention

Awaiting-confirmation, discarded, completed, and failed turns remain readable
for seven days by default. Daily cleanup removes expired rows and unreferenced
`.part`, `.tmp`, or `.pcm` files older than one hour. STT removes a turn's PCM
as soon as its draft is persisted.
