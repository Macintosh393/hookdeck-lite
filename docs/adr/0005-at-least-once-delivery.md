# ADR-0005: At-least-once delivery with a stable `webhook-id`

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead

## Context

A delivery attempt is an HTTP request to a system we do not control, followed by a database write that
records the result. The worker can crash between the two. When the job runs again we cannot know whether
the destination processed the first request. We must choose which mistake to make: sometimes send twice,
or sometimes not send at all.

Background: [delivery guarantees](../learning/webhooks-101.md#delivery-guarantees),
[idempotency](../learning/webhooks-101.md#idempotency).

## Decision

Delivery is **at-least-once**. Every event that fans out to a destination is attempted until it succeeds
or is marked `DEAD`; in rare cases the destination receives the same event more than once.

To let receivers handle that:

- Every outbound request carries `webhook-id`, and its value is the **Event id**.
- The value is the same for every retry, for a re-run after a stalled job, and for a manual replay,
  to every destination.
- `webhook-timestamp` is the send time of each attempt, so retries pass the receiver's tolerance check.
- `x-hdl-delivery-id` and `x-hdl-attempt` identify the specific delivery and attempt for debugging.

The README and dashboard tell receivers to store processed `webhook-id`s and ignore repeats.

Inbound, the mirror image applies: providers deliver at-least-once to us, and we deduplicate on
`(sourceId, externalEventId)`.

## Alternatives considered

| Option | Why not |
|---|---|
| At-most-once (record "sent" before sending, never resend) | A crash after recording and before sending loses the event silently. For webhooks, a lost payment or order event is worse than a duplicate |
| Exactly-once | Impossible across an HTTP boundary without the receiver's cooperation. "Exactly-once" systems are at-least-once delivery plus idempotent processing on the receiving side, which is what the stable id enables |
| `webhook-id` = Delivery id | Retries would still share an id, but a replay would get a new one, so a receiver that had already processed the event would process it again. The Standard Webhooks spec defines the id as identifying the message and staying the same across retries |
| A new id per attempt | Receivers could not deduplicate at all |

## Consequences

- No event is lost because of a worker crash (NFR2). Duplicates are possible after crashes, stalled jobs,
  forced shutdowns, and Redis data loss.
- Replaying a `SUCCEEDED` delivery to a receiver that deduplicates will be acknowledged and ignored by
  that receiver. This is correct behaviour and is noted next to the replay button.
- The same `webhook-id` is sent to different destinations of the same event. They are independent
  receivers, so this causes no conflict.
- We do not track which ids a receiver has seen. Deduplication is the receiver's job.

## What I should be able to explain

**Q: Why can't you guarantee exactly-once delivery?**
A: The send and the record of the send are in different systems. If we crash between them, we either
resend (maybe a duplicate) or do not (maybe a loss). No protocol removes that window; an idempotent
receiver makes the duplicate harmless.

**Q: How does a receiver deduplicate?**
A: It stores each `webhook-id` it has processed, with a unique constraint or a TTL cache, and returns 2xx
without reprocessing when it sees one again.

**Q: Why is `webhook-timestamp` not the event's original time?**
A: Receivers reject timestamps outside a tolerance window, typically five minutes, to stop replay attacks.
Our retries can happen hours later, so the timestamp must be the time of the attempt.
