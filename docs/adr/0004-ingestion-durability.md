# ADR-0004: Ingestion durability with "outbox-lite" and a sweeper

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead

## Context

When we return `202`, the provider considers the webhook delivered and will not send it again. So `202`
is a promise that the event will not be lost. Ingestion writes to two systems: Postgres (the record) and
Redis (the job that triggers processing). Two writes to two systems cannot be atomic. The process can die,
or Redis can be unreachable, between them. We also have a latency target: p95 under 20 ms.

Background: [the outbox pattern](../learning/reliability-patterns.md#the-outbox-pattern).

## Decision

Ingestion does, in order: verify signature → rate-limit check → insert the `Event` row (the unique index
handles dedupe) → enqueue a `fanout` job with `jobId = event.id` → return `202`.

- The **Postgres insert is the commit point**. If it fails, return `503`.
- The **enqueue is best effort**. If it fails, log it and still return `202`.
- A **sweeper** in the worker runs every `SWEEPER_INTERVAL_MS`. It finds Events still `RECEIVED` after
  `SWEEPER_STUCK_AFTER_MS` and enqueues them. Because the job id is the event id, enqueueing an event that
  already has a job does nothing.
- The same sweeper reconciles Deliveries (`PENDING`, or `RETRYING` past `nextAttemptAt`), which covers a
  crash between the fan-out commit and the enqueue of delivery jobs, and a Redis data loss.
- The sweeper is a `setInterval`, not a BullMQ Job Scheduler. It must work when Redis has just come back
  empty, it is idempotent so several workers may run it, and it adds no third queue.

Rules and edge cases: [QUEUES.md](../QUEUES.md#sweeper).

## Alternatives considered

| Option | Latency cost | Durability | Why not |
|---|---|---|---|
| **(a) Redis-only ingestion**: enqueue the payload, return 202, write Postgres later in the worker | Lowest: one Redis round trip, about 1 ms | Depends entirely on Redis persistence. With AOF `everysec`, a Redis crash loses up to a second of acknowledged events. With a failover, possibly more. Payloads sit in Redis memory | Violates the 202 promise under ordinary failures. Also puts bodies and possibly sensitive data in Redis |
| **(b) Full transactional outbox**: insert the Event and an outbox row in one transaction; a relay process polls or tails the outbox and publishes to Redis | One Postgres transaction with two inserts; then relay delay (polling interval, or logical decoding for low latency) before processing starts | Strongest: the intent to publish is committed atomically with the data | A relay to build, run, and monitor; an outbox table to prune; either polling latency on every event or CDC infrastructure. Too much for four days |
| **Outbox-lite (chosen)** | One Postgres insert plus one Redis call, typically 3–8 ms locally. The happy path has no polling delay | Same guarantee as (b) for acknowledged events: the Event row *is* the outbox record, with `status = RECEIVED` meaning "not yet published". Recovery is delayed by up to 45 s, only when the enqueue failed | Chosen |
| Enqueue first, then insert | Same latency | A job could run before, or without, its Event row. The worker would need retry-until-visible logic, and an event could be processed without being stored | Wrong order: the durable write must come first |

The insight that makes outbox-lite work: the Event row already records everything needed to publish, and
its status tells us whether publishing happened. A separate outbox table would duplicate that.

## Consequences

- An accepted event survives a Redis outage, a Redis data loss, and an API crash after the insert.
- Ingestion availability depends on Postgres only. Redis being down slows delivery, not acceptance.
- In the failure case, processing starts up to `SWEEPER_STUCK_AFTER_MS + SWEEPER_INTERVAL_MS` (45 s) late.
- The sweeper queries Postgres every 15 s. Indexes on `(status, receivedAt)` and `(status, nextAttemptAt)` keep that cheap.
- An event can be enqueued twice in rare races (the sweeper and the API). The fan-out processor's
  compare-and-set on `Event.status` makes the second run a no-op.
- The latency target includes a synchronous Postgres commit. That is the price of the promise.

## What I should be able to explain

**Q: What happens if Redis is down when a webhook arrives?**
A: The event is inserted into Postgres and we return 202. The enqueue fails and is logged. When Redis is
back, the sweeper finds the event still `RECEIVED` and enqueues it.

**Q: How is this different from a real transactional outbox?**
A: A full outbox writes a separate outbox row in the same transaction and has a relay publish every
message. We use the Event row itself as the outbox record and publish directly on the happy path; the
sweeper is the relay, used only for leftovers. Same guarantee, fewer moving parts, slower recovery.

**Q: Why not acknowledge after a Redis enqueue alone? It is faster.**
A: Because Redis can lose acknowledged writes on a crash, and the provider will not resend what we
acknowledged. Durability of a 202 has to rest on the database.
