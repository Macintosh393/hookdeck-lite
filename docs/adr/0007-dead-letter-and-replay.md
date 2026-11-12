# ADR-0007: Dead letters in Postgres and immutable replay

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead

## Context

Some deliveries will never succeed by themselves: the retries run out, or the destination answers with a
permanent error. Those must be kept, shown, and re-sendable after a human fixes the cause. BullMQ has no
dead-letter queue. A job that exhausts its attempts moves to the queue's `failed` set, which is trimmed by
`removeOnFail` and lives in Redis memory. An audit trail must also stay trustworthy: what happened must
not be rewritten by later actions.

Background: [dead-letter queues](../learning/reliability-patterns.md#dead-letter-queues).

## Decision

**The dead letter is the Delivery row.** When a delivery fails for the last time, the processor sets
`Delivery.status = DEAD` with a `deadReason` in the same transaction as the final attempt row, then throws
`UnrecoverableError` so BullMQ stops. Postgres is the source of truth; the dashboard's dead-letter view is
`GET /api/v1/deliveries?status=DEAD`.

Two backstops cover a job that fails without the processor running (a job stalled more than
`maxStalledCount` times): the worker's `failed` listener, and the sweeper, which marks a non-terminal
Delivery `DEAD` when its job is in BullMQ's failed set.

**Replay creates a new Delivery.** It has `trigger = REPLAY` and `replayOfId` pointing at the original,
a fresh attempt counter, and its own attempts. The original row and its attempts are never updated.

- Single replay: `POST /api/v1/deliveries/{id}/replay`, allowed when the original is `DEAD` or `SUCCEEDED`.
- Bulk replay: `POST /api/v1/destinations/{id}/replay-dead` replays every `DEAD` delivery of the
  destination that has no replay yet, at most 1000 per call.
- A replay uses the destination's current URL and secret and the event's original body and `webhook-id`.

## Alternatives considered

| Option | Why not |
|---|---|
| A third BullMQ queue as the DLQ | Dead letters would live in Redis: memory-bound, trimmed by retention, not queryable by tenant, destination, or time, and lost if Redis is. We would still need Postgres for the dashboard |
| Use BullMQ's `failed` set directly and `job.retry()` for replay | Same storage problems. `job.retry()` reuses the job, so the history of the first run and the replay blur together |
| Mark `DEAD` only from the `failed` event listener | The listener runs after the job has failed, in a separate step. If the process dies in between, the Delivery stays `RETRYING` forever. Writing `DEAD` in the processor's transaction makes the terminal state atomic with the last attempt |
| Replay resets the original Delivery to `PENDING` | Destroys history: the row that said "DEAD after 10 attempts at 12:41" would say something else. Metrics for past windows would change. Concurrent replays would race on one row |
| Replay re-ingests the event as a new Event | Would fan out to every connection again, not just the failed one, and would duplicate the event in lists |
| Bulk replay as a background job | Better for very large sets. A bounded synchronous call (1000 rows, one `createMany`, one `addBulk`) is simple and enough here |

## Consequences

- Dead letters survive a Redis loss and are queryable with ordinary SQL.
- The history is append-only: every attempt ever made remains visible, and a replay is visibly a replay.
- A chain is possible (a replay of a replay). `replayOfId` always points at the delivery that was replayed.
- Bulk replay skips deliveries that already have a replay, so pressing the button twice does not double-send.
- Replays count as deliveries in metrics. End-to-end latency queries exclude `trigger = REPLAY`.
- Retention of BullMQ's failed set (`removeOnFail`) matters only for debugging and for the sweeper's check.

## What I should be able to explain

**Q: BullMQ has no DLQ. What did you do instead?**
A: The Delivery row in Postgres is the dead letter. The processor marks it `DEAD` in the same transaction
that records the final attempt, and the dashboard lists those rows. Redis holds no dead-letter state.

**Q: Why does replay create a new row instead of resetting the old one?**
A: To keep history immutable. The original outcome stays on record, metrics for past periods do not
change, and each replay has its own attempts and status.

**Q: What stops a bulk replay from sending duplicates if someone clicks twice?**
A: It only selects `DEAD` deliveries that have no child replay yet, so a second call finds nothing new.
