# ADR-0002: NestJS API on Fastify, plain BullMQ worker, Next.js dashboard

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead

## Context

Ingestion must answer in milliseconds. Delivery is slow, bursty, and failure-prone. The lead is learning
BullMQ and wants to read queue code without a framework in between. The dashboard is an authenticated,
data-heavy single-page experience.

## Decision

Three apps.

- **`apps/api`**: NestJS 12 on the Fastify adapter. Ingestion, the management REST API, the SSE stream,
  and the probes. It produces jobs and never processes them.
- **`apps/worker`**: plain TypeScript using BullMQ directly, with no NestJS. Fan-out processor, delivery
  processor, and the sweeper.
- **`apps/web`**: Next.js (App Router) used as a client-heavy app. It calls the API from the browser.
  No server actions and no server-side data fetching with secrets.

Shared code lives in three packages: `shared` (browser-safe types, Zod schemas, filter engine),
`database` (Prisma), and `core` (Node-only: queues, Redis, backoff, HMAC, encryption, HTTP client, rate limiter).

## Alternatives considered

| Option | Why not |
|---|---|
| Worker inside the API process | A burst of slow deliveries would compete with ingestion for the event loop. A worker crash would take ingestion down. They could not be scaled or deployed separately |
| Worker built with `@nestjs/bullmq` | The `@Processor` and `@OnWorkerEvent` decorators hide worker construction, connection options, backoff strategy wiring, and shutdown. Those are exactly the mechanics the lead needs to see and explain |
| NestJS on Express | Fastify has lower per-request overhead, which matters for the ACK latency target, and it exposes the raw body cleanly |
| NestJS on the new `NodeAdapter` | NestJS docs recommend it from v12.3 and it becomes the default in v13. It is new, and the Fastify adapter is mature and still supported. Revisit after the project |
| Plain Fastify for the API | Less framework, but the management API benefits from Nest's modules, guards, pipes, and DI, and the lead already knows Nest's style |
| A Vite SPA for the dashboard | Works. Next.js gives routing, a one-command Vercel deploy, and is the stack the lead wants to show |
| `core` merged into `shared` | `shared` must run in the browser for the filter tester. `core` imports `node:crypto`, `ioredis`, and `undici` |

## Consequences

- The API and worker scale and fail independently. If the worker is down, ingestion keeps accepting events.
- Two processes to run locally and two Docker images to build.
- The worker has no DI container: dependencies are constructed in `main.ts` and passed as arguments.
  That is more explicit and slightly more wiring.
- The dashboard needs CORS on the API and holds the API key in the browser ([ADR-0013](0013-auth-scope-cut.md)).
- Fastify-specific details apply to the API: explicit CORS methods, `useBodyParser` for the body limit,
  listening on `0.0.0.0` in containers.

## What I should be able to explain

**Q: Why is the worker a separate process without NestJS?**
A: Isolation and clarity. Slow outbound HTTP cannot affect ingestion latency, a crash in one does not stop
the other, and the BullMQ code is readable top to bottom without decorators generating it.

**Q: Why does the filter engine live in `shared` and not in the worker?**
A: The dashboard's filter tester runs the same function in the browser, so a preview can never disagree
with what the worker does.

**Q: What does the API do when the worker is down?**
A: It keeps accepting and storing events and enqueueing jobs. They wait in Redis until a worker starts.
