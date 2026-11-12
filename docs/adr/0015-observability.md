# ADR-0015: pino logs with correlation ids, `/health` and `/ready`

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead

## Context

One webhook passes through an HTTP request in the API, a fan-out job, and one or more delivery jobs with
several attempts each, across two processes. When something goes wrong, we need to follow one event
through all of that. The hosting platform also needs to know whether a process is alive and whether it
can serve traffic.

## Decision

**Logging.** pino, JSON to stdout, in both apps.

- Every log line in the pipeline carries `tenantId`, `eventId`, and `deliveryId` where they apply. The API
  adds `requestId`; the worker adds `jobId`, `queue`, and `attemptNumber`.
- A child logger is created once per request or job with those fields bound, and passed down.
- Redaction: `authorization`, `cookie`, signature headers, secrets, API keys. Bodies are never logged.
- `LOG_LEVEL` controls verbosity. Development pretty-prints with `pino-pretty`; production emits raw JSON.

**Probes** on the API:

- `GET /health` is **liveness**: `200` if the process can answer. It checks no dependency.
- `GET /ready` is **readiness**: runs `SELECT 1` and Redis `PING` with a 1 s timeout each; `200` if both
  succeed, else `503` with per-check results.

The worker has no HTTP server. It logs a line on start, on shutdown, and a heartbeat with queue counts
every 60 seconds.

**Request ids.** The API accepts an incoming `x-request-id` or generates one, returns it in the response
header, and includes it in error bodies.

## Alternatives considered

| Option | Why not |
|---|---|
| `console.log` | Unstructured text cannot be filtered by event id, and it is slow under load |
| winston | Works. pino is faster, JSON-first, and is already Fastify's native logger |
| NestJS's built-in `ConsoleLogger` | Structured output exists in v12, but the worker does not use NestJS and both apps should log in one format |
| OpenTelemetry traces and metrics | The proper tool for following a request across services. It needs a collector and a backend to be useful. Correlation ids in logs give most of the value for a system this size. BullMQ has an OpenTelemetry integration if this is added later |
| Prometheus `/metrics` endpoint | Useful for alerting. The dashboard's metrics come from Postgres, which is enough for the demo |
| One combined health endpoint that checks dependencies | If liveness depends on Redis, a Redis outage makes the platform restart healthy API processes in a loop. Liveness and readiness answer different questions |
| `@nestjs/terminus` for the probes | Fine, and it removes little code here: two checks and a status code. Fewer dependencies wins |
| A health HTTP server in the worker | Render background workers need no port. A heartbeat log line is enough |

## Consequences

- `grep eventId=<id>` (or a JSON filter) over both apps' logs shows an event's whole journey.
- Ingestion stays up when Redis is down (`/health` is `200`), while `/ready` correctly reports `503`.
  Platform health checks must point at `/health`, not `/ready`, or a Redis outage would take ingestion offline.
- No distributed tracing, no metrics endpoint, no alerting. Acceptable for this scope.
- Discipline is needed: a log line without the ids is a defect. Review checks for it.
- Whether to use `nestjs-pino` or Fastify's built-in pino logger is an implementation detail.
  Settled on Day 1: Fastify's built-in logger (`loggerInstance`), plus a small `LoggerService` adapter
  for NestJS's own lines. `nestjs-pino` 5.3.1 is compatible with NestJS 12 but keeps one process-wide
  `pino-http` instance, which does not fit tests that build several apps.

## What I should be able to explain

**Q: What is the difference between liveness and readiness?**
A: Liveness asks "is the process stuck and in need of a restart?". Readiness asks "can it serve traffic
right now?". A dependency outage should fail readiness, not liveness, or the platform restarts processes
that are fine.

**Q: How would you trace one webhook through the system?**
A: By its `eventId`, which is on every log line from ingestion through fan-out and each delivery attempt,
together with `deliveryId` and `tenantId`.

**Q: What must never appear in logs?**
A: Secrets, API keys, signature values, and payload bodies. Redaction is configured in the logger, and a
test scans the logs of a full cycle for them.
