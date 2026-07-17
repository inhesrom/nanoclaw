# EvenHub WhatsApp turn lifecycle

After local speech recognition persists a transcript, NanoClaw relays it through
the registered WhatsApp main self-chat. This deliberately reuses normal message
storage, group context, queueing, agent execution, and reply delivery instead of
creating a second agent path.

## Prompt correlation

The coordinator processes one G2 prompt at a time:

1. Reserve a Baileys-compatible message ID in `even_turns` while the turn is
   `dispatching`.
2. Send the raw transcript to the registered WhatsApp self-chat with that ID.
3. Store the confirmed message with a host-only `even_turn_id`; never put a
   correlation marker in visible text.
4. Compare-and-set the turn to `queued`. The normal NanoClaw message loop marks
   it `running` when agent processing starts.

If the local message was stored before a restart, reconciliation can safely
finish `dispatching → queued` without another relay. A reserved ID without a
stored message is ambiguous. Because remote custom-ID deduplication has not yet
passed the physical WhatsApp integration gate, recovery fails that turn closed
instead of risking a duplicate visible prompt.

## Reply boundary

The first non-empty correlated agent result uses a confirmed WhatsApp send. Only
after that send returns a message ID does NanoClaw atomically store the exact
send argument as `answer` and move `running → completed`. The API and G2 paging
consume that same immutable Unicode string. Logs contain IDs, states, timings,
and lengths, never transcript or answer text.

An unconfirmed reply becomes terminal `whatsapp_unavailable`. A process restart
while a turn is `running` is delivery-ambiguous and becomes `agent_failed`; it is
not replayed. Agent failures before any reply retain the normal queue retry
budget, then become `agent_failed` when retries are exhausted.

## Retention

Completed and failed turns remain readable for seven days by default. Daily
cleanup removes expired rows and deletes unreferenced `.part`, `.tmp`, or `.pcm`
files older than one hour. Referenced nonterminal audio is never treated as an
orphan.
