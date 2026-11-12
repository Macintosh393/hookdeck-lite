# ADR-0010: Per-tenant sliding-window-counter rate limiting in Lua

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead

## Context

One tenant's burst (a provider replaying a backlog, a misconfigured loop) should not exhaust Postgres
connections or queue capacity for everyone. We need a per-tenant limit on ingestion that is cheap enough
to sit on the hot path, correct under concurrency, and shared across API instances.

Background: [rate limiting algorithms](../learning/reliability-patterns.md#rate-limiting-algorithms),
[Lua scripts](../learning/bullmq-101.md#lua-scripts).

## Decision

A **sliding-window counter** per tenant, stored in Redis and evaluated by one **Lua script**.

- Limit: `Tenant.ingestRateLimit` requests per 60-second window (default 600).
- Two counters per tenant: the current and the previous fixed window. The estimate is
  `previous × (fraction of the previous window still inside the sliding window) + current`.
- The script reads both counters, decides, and increments in one atomic step.
- Over the limit: `429`, code `RATE_LIMITED`, `Retry-After` in seconds.
- The check runs **after** signature verification, so forged requests do not consume a tenant's quota.
- If Redis is unavailable, the limiter **fails open**.

Script and details: [SECURITY.md](../SECURITY.md#rate-limiting).

## Alternatives considered

| Algorithm | Memory per tenant | Accuracy | Why not |
|---|---|---|---|
| **Fixed window** (one counter per minute) | 1 key | Poor at boundaries: a client can send `limit` requests at 11:59:59 and `limit` more at 12:00:00, twice the limit in two seconds | The boundary burst is exactly the spike we want to stop |
| **Sliding log** (a sorted set with one entry per request) | 1 entry per request in the window. At 600/min that is 600 entries; at 100 000/min it is 100 000 | Exact | Memory and CPU grow with traffic (`ZADD`, `ZREMRANGEBYSCORE`, `ZCARD` per request). Exactness is not needed here |
| **Sliding-window counter** (chosen) | 2 keys | Approximate: assumes requests in the previous window were evenly spread. Cloudflare measured about 0.003 % of requests misjudged on real traffic | Chosen: constant memory, O(1) work, no boundary burst |
| **Token bucket** | 2 fields | Exact for its model; allows controlled bursts | A good alternative. Its "burst size plus refill rate" model is harder to explain to a tenant than "N per minute", and the brief specified a sliding window |

Other choices:

| Option | Why not |
|---|---|
| `INCR` and `EXPIRE` as separate commands from Node | Not atomic. Two requests can both read 599, both pass, and both increment. A crash between `INCR` and `EXPIRE` leaves a counter that never expires |
| `MULTI`/`EXEC` transaction | Makes the writes atomic but cannot branch on a value read inside the transaction. The read-decide-write needs a script (or `WATCH` with retries) |
| In-memory limiter in the API process | Not shared across instances and reset on restart |
| `@nestjs/throttler` | Guards are per route and keyed by IP by default. We need a per-tenant key resolved after signature verification, and we want to own and understand the algorithm |
| Limit before verifying the signature | Cheaper per request, but anyone who knows a source URL could exhaust the tenant's quota with garbage |
| Fail closed when Redis is down | Would reject genuine webhooks during a Redis outage, which contradicts the design goal that ingestion depends only on Postgres |

## Consequences

- The limit holds under concurrency and across API instances.
- The count is an estimate. A tenant can occasionally get slightly more or fewer than the limit near
  window boundaries. That is acceptable for load protection.
- Each ingestion request costs one extra Redis round trip (about 0.2–0.5 ms locally).
- During a Redis outage there is no rate limiting. Postgres is then the only backpressure.
- Sources in mode `none` have no signature step, so their limit is the only gate; an attacker can use up
  that tenant's quota. The dashboard marks unverified sources.
- The clock is the API server's. Multiple API instances with skewed clocks would disagree about window
  boundaries by the skew. Acceptable.

## What I should be able to explain

**Q: Why does the rate limiter need a Lua script?**
A: Check-then-increment must be one atomic step. Redis runs a script to completion without interleaving
other clients' commands, so two concurrent requests cannot both see the last free slot.

**Q: What is wrong with a fixed window?**
A: Bursts at the boundary. A client can use the whole limit at the end of one window and again at the
start of the next, doubling the allowed rate for a moment.

**Q: Why fail open?**
A: The limiter protects capacity; it is not a security boundary. If its store is down, rejecting real
webhooks would turn a partial outage into data loss for tenants.
