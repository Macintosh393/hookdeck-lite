# ADR-0003: Hookdeck-style domain model and UUID v7 ids

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead

## Context

We need to model where webhooks come from, where they go, which ones go where, and what happened to each
one. The model must support many-to-many routing, per-route filters, a full attempt history, and replay.
It must be multi-tenant in the data even though there is no user management.

## Decision

```
Tenant ─┬─ Source ──┐
        │           ├─ Connection (filter)
        └─ Destination ┘
Source ── Event ── Delivery (one per matching Connection) ── DeliveryAttempt (one per HTTP try)
```

- **Source**: an inbound endpoint (`/in/{slug}`) with its own verification mode and secret.
- **Destination**: an outbound URL with its own signing secret.
- **Connection**: routes one Source to one Destination, optionally through a filter. Unique per pair.
- **Event**: one accepted webhook. Immutable payload.
- **Delivery**: the task of getting one Event to one Destination. Has a status and a retry counter.
- **DeliveryAttempt**: one HTTP request and its outcome. Immutable.

Every tenant-owned table carries `tenantId`. Ids are UUID v7. Full schema: [DATA-MODEL.md](../DATA-MODEL.md).

## Alternatives considered

| Option | Why not |
|---|---|
| Svix-style: Application → Endpoint, messages sent by API | Fits "I send webhooks to my customers". Our problem is the receiving side: verify, route, and forward what providers send |
| Source has a list of destination URLs, no Connection | No place for a per-route filter or a per-route enable switch, and no many-to-many |
| No Delivery entity: attempts hang off (Event, Destination) | Status, retry counter, `nextAttemptAt`, and the replay link need a row to live on. Without it the DEAD view is an aggregate query over attempts |
| Auto-increment integer ids | Guessable, and BullMQ rejects all-digit custom job ids |
| UUID v4 | Random inserts scatter across the index; ordering needs a separate column. UUID v7 is time-ordered, so `ORDER BY id DESC` is "newest first" and inserts append |
| `tenantId` only on root entities, joined when needed | Every list query would join up to the Source or Destination to scope by tenant. A denormalized column is cheaper and makes tenant isolation checkable in one `WHERE` |

## Consequences

- Fan-out is a simple loop over a Source's Connections.
- The dashboard can show an Event with its Deliveries and each Delivery with its attempts, with no aggregation.
- Three levels of rows per webhook: storage grows with attempts. Retention is documented and the job is a stretch goal.
- UUID v7 ids leak creation time. That is acceptable; they are not secrets.
- Cursor pagination can use the id alone.

## What I should be able to explain

**Q: Why separate Delivery from DeliveryAttempt?**
A: A Delivery is the goal ("get event E to destination D") and has a lifecycle. An attempt is one HTTP
request. Retries create attempts under the same Delivery; replay creates a new Delivery.

**Q: Why UUID v7 instead of v4?**
A: v7 starts with a timestamp, so ids sort by creation time. That keeps B-tree inserts local and gives
free ordering for cursor pagination.

**Q: How is tenant isolation enforced?**
A: Every row has `tenantId` and every query filters on the tenant resolved from the API key. Accessing
another tenant's id returns 404.
