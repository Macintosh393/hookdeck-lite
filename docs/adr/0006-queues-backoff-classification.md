# ADR-0006: Two queues, custom backoff with full jitter, response classification

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead

## Context

After an event is stored, two different kinds of work follow. Fan-out is fast, internal, and fails only
when our own systems fail. Delivery is slow, external, and fails for reasons we do not control. Retrying
has to be patient with a struggling destination without retrying forever, and it must not make an outage
worse by having every failed delivery retry at the same instant.

Background: [backoff and jitter](../learning/reliability-patterns.md#backoff-and-jitter),
[retries in BullMQ](../learning/bullmq-101.md#retries).

## Decision

**Two BullMQ queues**: `fanout` (one job per Event) and `delivery` (one job per Delivery; each run of the
job is one HTTP attempt).

**Retries** use BullMQ's `attempts` option with `backoff: { type: 'custom' }` and a `backoffStrategy` on
the Worker. The delivery processor computes the delay with a pure function, stores it as
`Delivery.nextAttemptAt`, and throws `RetryableDeliveryError(delayMs)`. The strategy returns that value.

**Delay formula**: `delay = max( random(0, min(cap, base × 2^(n−1))), min(retryAfter, cap) )`, with
`base = 30 s`, `cap = 1 h`, and 10 attempts in total. `Retry-After` is honored on `429` and `503`.

**Classification**: `2xx` success. `408`, `429`, `5xx`, timeouts, and network, DNS, and TLS errors are
retryable. Every other `4xx`, any `3xx`, and SSRF blocks are permanent and throw `UnrecoverableError`.

Full spec, table, and worked delays: [QUEUES.md](../QUEUES.md).

## Alternatives considered

| Option | Why not |
|---|---|
| One queue with job types | Fan-out and delivery need different concurrency, retry policy, and retention. A backlog of slow deliveries would delay fan-out of new events |
| One job per attempt, scheduling the next as a new delayed job | Works, but re-implements what `attempts` + backoff already do, and loses the single job id per Delivery that the sweeper relies on |
| BullMQ built-in `exponential` backoff with `jitter` | Verified to exist in v6 (`jitter` between 0 and 1). It cannot take `Retry-After` into account, has no cap, and the delay is not known to the processor, so `nextAttemptAt` could not be stored exactly |
| Plain exponential backoff, no jitter | All deliveries that failed together retry together, producing synchronized spikes against a recovering destination (the thundering herd) |
| "Equal jitter" (half fixed, half random) | Guarantees a minimum wait but spreads load less. AWS's analysis shows full jitter completes with fewer total calls. The possibility of a very short delay is acceptable here |
| Fixed-interval retries | Either too aggressive during an outage or too slow to recover from a blip |
| Retrying all `4xx` | A `400`, `401`, or `404` will not change by itself. Retrying wastes 3 hours and hides a configuration error that a human must fix |
| Treating only specific `5xx` as retryable | Servers and proxies return many `5xx` codes for transient conditions. Defaulting `5xx` to retryable is the safer mistake |
| Following the Standard Webhooks example schedule (10 attempts over about 75 hours) | Good for production. Too long to observe or test in a four-day project. Our schedule is configurable, so it can be lengthened by env vars |

## Consequences

- The backoff logic is a pure function with an injected random source, so it is fully unit-testable.
- The processor, not BullMQ, decides the delay. BullMQ only executes it. `nextAttemptAt` in Postgres is exact.
- The attempt counter of record is `Delivery.attemptCount` in Postgres. BullMQ's `attemptsMade` can drift
  from it after stalls, so the processor decides finality from Postgres.
- With full jitter a retry can come almost immediately. The expected delay is half the ceiling.
- A destination that is down for more than about 3 hours will produce `DEAD` deliveries. Operators replay
  them, or raise `DELIVERY_MAX_ATTEMPTS` and `BACKOFF_CAP_MS`.
- `Retry-After` is capped at `BACKOFF_CAP_MS`, so a receiver cannot park a job indefinitely.

## What I should be able to explain

**Q: Why add jitter to exponential backoff?**
A: Without it, every delivery that failed at the same moment retries at the same moments, so a recovering
destination is hit by waves. Random delays spread the retries evenly over time.

**Q: Why is a 404 permanent but a 503 retryable?**
A: A 503 says "not now": the same request may succeed later. A 404 says "not here": the same request will
fail until someone changes the URL, so retrying only adds load and delay.

**Q: How does `Retry-After` interact with your backoff?**
A: It is a lower bound. We wait at least as long as the receiver asked, up to the cap, and otherwise use
our jittered delay.
