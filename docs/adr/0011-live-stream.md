# ADR-0011: Live stream with Redis pub/sub and Server-Sent Events

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead

## Context

The dashboard should show events and delivery attempts as they happen. The facts originate in the worker
(and, for `event.received`, in the API). The browser talks only to the API. So something must carry
messages from the worker process to the API process, and something must push them from the API to the
browser. Messages are per tenant. Losing a live message is tolerable, because Postgres has the truth and
the dashboard can refetch.

Background: [Redis pub/sub](../learning/bullmq-101.md#redis-pubsub),
[Server-Sent Events](../learning/reliability-patterns.md#server-sent-events).

## Decision

- **Worker → API**: Redis pub/sub. Publishers send a `StreamMessage` JSON to channel
  `hdl:stream:{tenantId}`. The API holds one dedicated subscriber connection and subscribes to a tenant's
  channel while at least one client of that tenant is connected.
- **API → browser**: Server-Sent Events at `GET /api/v1/stream`, authenticated with the API key. NestJS's
  `@Sse()` returns an Observable; a comment line is sent every 15 seconds as keep-alive.
- **Browser**: reads the stream with `fetch` and a streaming reader (parsed with `eventsource-parser`),
  because the native `EventSource` cannot send an `Authorization` header. On disconnect it reconnects with
  backoff and refetches the visible lists.
- **Message types**: `event.received`, `event.fanned_out`, `delivery.created`, `delivery.attempted`.
- Publishing is best effort: a failed publish is logged and never fails the job or request.

## Alternatives considered

Transport to the browser:

| Option | Why not |
|---|---|
| WebSockets | Bidirectional, which we do not need: the browser only listens. Needs an upgrade handshake, a gateway in NestJS, its own auth step, and manual reconnect. Some proxies still treat it specially |
| Polling every few seconds | Simplest. Either laggy or wasteful, and it does not demonstrate a live stream |
| **SSE (chosen)** | Plain HTTP: works through proxies and load balancers, uses the same auth guard as every other route, and is one decorator in NestJS. One-directional, which matches the need |

Transport between worker and API:

| Option | Why not |
|---|---|
| BullMQ `QueueEvents` | It reports queue-level facts (`completed`, `failed`, `delayed`, with a job id), not domain facts. It carries no `tenantId`, status code, or attempt number, so the API would have to query Postgres for every event to enrich and route it. It also couples the UI to queue internals: one job spans many attempts, and fan-out has no per-delivery event. It uses Redis Streams, which are durable and trimmed, a feature we do not need here |
| Redis Streams with consumer groups | Durable and replayable (`Last-Event-ID` could work). More code: trimming, IDs, and catch-up logic. Not needed when the dashboard can refetch |
| Postgres `LISTEN/NOTIFY` | Would work and removes Redis from this path, but payloads are limited to 8000 bytes, each listener holds a database connection, and we already run Redis |
| The API polls Postgres and diffs | Adds load and latency for the same result |
| **Redis pub/sub (chosen)** | Fire-and-forget fan-out to all API instances, per-tenant channels, messages shaped for the UI |

Authentication for the stream:

| Option | Why not |
|---|---|
| Native `EventSource` with the key in the query string | Keys in URLs end up in access logs, browser history, and referrers |
| A short-lived stream token endpoint | Clean, but another endpoint and token store. `fetch` streaming gives header auth with no new moving part |

## Consequences

- No delivery guarantee on the stream. A message published while a client is reconnecting is missed; the
  client refetches on reconnect. There is no `Last-Event-ID` support.
- The API needs a second Redis connection, because a subscribed connection cannot run other commands.
- Works with several API instances: every instance subscribed to a tenant's channel receives every message.
- Long-lived connections count against the host's connection limits. A keep-alive comment every 15 s
  prevents idle timeouts at proxies. `UNVERIFIED`: Render documents no maximum duration for WebSockets but
  says nothing explicit about SSE; Day 4 checks it on the deployed service.
- NestJS drops an SSE client whose outgoing buffer exceeds about 4 million characters. A stalled tab reconnects.
- The dashboard needs a small fetch-based SSE client instead of one line of `new EventSource()`.

## What I should be able to explain

**Q: Why SSE instead of WebSockets?**
A: The data flows one way, server to browser. SSE is ordinary HTTP, so the existing auth guard, CORS, and
proxies work unchanged, and there is no protocol upgrade to manage.

**Q: Why not use BullMQ's `QueueEvents` for the live feed?**
A: Its events describe jobs, not deliveries. They lack tenant, status code, and attempt number, so every
event would need a database lookup, and the UI would depend on queue internals. Publishing our own
messages keeps the UI contract in domain terms.

**Q: What happens to messages published while the browser is disconnected?**
A: They are gone. Pub/sub does not store anything. The dashboard refetches its lists on reconnect, and
Postgres is the source of truth.
