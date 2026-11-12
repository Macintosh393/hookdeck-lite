# Product Requirements: hookdeck-lite

## Problem

Receiving webhooks reliably is harder than it looks. A provider (Stripe, GitHub, a partner's system) sends an
HTTP request and expects a `2xx` within a few seconds. If your handler is slow, down, or mid-deploy, the
provider retries on its own schedule, gives up on its own schedule, and offers little visibility. Teams end
up writing the same infrastructure again and again: signature checks, a queue, retries, a dead-letter list,
and a way to replay.

hookdeck-lite is that infrastructure as one self-hosted service. It sits between providers and your
endpoints. It accepts the webhook quickly and durably, then takes over delivery.

Background for readers new to the domain: [learning/webhooks-101.md](learning/webhooks-101.md).

## Target users

| User | Need |
|---|---|
| Backend developer at a small team | Stop losing webhooks during deploys and outages; see what was received and what failed. |
| Developer integrating a new provider | Inspect real payloads, test filters, and replay events while building the handler. |
| Reviewer of this portfolio project | Read a small, well-documented codebase that handles reliability and security properly. |

## Goals

1. Never lose an accepted event. Once the gateway returns `202`, the event is in Postgres.
2. Acknowledge fast, so providers never time out because of downstream slowness.
3. Deliver at least once, with retries that back off sensibly, and make failures visible and replayable.
4. Be safe to expose: verify inbound signatures, sign outbound requests, block SSRF, limit request rates.
5. Be understandable: every decision has an ADR, every new concept has a `LEARN:` comment and a learning doc.

## Non-goals

- User accounts, login, organizations, roles, or billing. Auth is one API key per tenant
  ([ADR-0013](adr/0013-auth-scope-cut.md)).
- Exactly-once delivery. Duplicates are possible and documented ([ADR-0005](adr/0005-at-least-once-delivery.md)).
- Payload transformation, custom code, or templating.
- Strict ordering of deliveries. Retries reorder by design.
- Multi-region, high availability, or horizontal autoscaling. One API instance and one worker are the target.
- Provider-specific presets (Stripe's `t=…,v1=…` header and similar). `generic-hmac` covers GitHub-style signing only.

## Features (MoSCoW)

### Must

| ID | Feature |
|---|---|
| M1 | Ingestion endpoint with fast `202` and durable storage |
| M2 | Inbound signature verification per source (`standard-webhooks`, `generic-hmac`, `none`) |
| M3 | Inbound deduplication on `(sourceId, externalEventId)` |
| M4 | Per-tenant rate limiting on ingestion |
| M5 | Fan-out of an event to every enabled, matching connection |
| M6 | Filter rules on `body`, `headers`, `query` |
| M7 | Delivery with retries, backoff with jitter, `Retry-After`, and response classification |
| M8 | Outbound signing with Standard Webhooks headers |
| M9 | SSRF-safe outbound HTTP client |
| M10 | Dead-lettering (`DEAD`) and single replay |
| M11 | Sweeper that recovers events and deliveries that never reached the queue |
| M12 | Management API: CRUD for sources, destinations, connections; list and detail for events and deliveries |
| M13 | API-key authentication for the management API and the stream |
| M14 | Dashboard: events list, event detail with attempts timeline, DEAD view, replay button, live stream |
| M15 | Structured logs, `/health`, `/ready` |
| M16 | Secrets encrypted at rest |

### Should

| ID | Feature |
|---|---|
| S1 | Bulk replay of all `DEAD` deliveries for a destination |
| S2 | Metrics endpoint and dashboard charts (success rate, p50/p95 latency, volume) |
| S3 | Filter-rule tester in the dashboard, using the shared engine |
| S4 | Dashboard CRUD forms for sources, destinations, connections |
| S5 | Rotate a destination's signing secret |
| S6 | Auto-disable a destination that answers `410 Gone` |
| S7 | Deployed demo (Render + Vercel) and CI |

### Could (stretch)

| ID | Feature |
|---|---|
| C1 | Circuit breaker per destination |
| C2 | Retention job that deletes events older than `RETENTION_DAYS` |
| C3 | Forwarding selected inbound headers to the destination |
| C4 | Rate limiting on the management API |
| C5 | Master-key rotation tooling |

### Won't (this version)

Payload transformations, user and organization management, provider presets, ordered delivery,
webhook-id-based outbound idempotency storage for receivers, a hosted multi-tenant signup flow.

## User stories and acceptance criteria (Musts)

Each criterion is written to be turned into a test. "AC" numbers are referenced from [TESTING.md](TESTING.md).

### M1 — Fast, durable ingestion

*As a provider, I POST a webhook and get an acknowledgement quickly, so I do not retry needlessly.*

- AC1.1 `POST /in/{sourceSlug}` with a valid request returns `202` and a JSON body containing the event `id`.
- AC1.2 When the response is `202`, an `Event` row with status `RECEIVED` or later exists in Postgres.
- AC1.3 If Redis is unreachable, the response is still `202` and the Event row exists.
- AC1.4 If Postgres is unreachable, the response is `503` and nothing is enqueued.
- AC1.5 An unknown or disabled `sourceSlug` returns `404`.
- AC1.6 A body larger than `INGEST_MAX_BODY_BYTES` returns `413`. A non-JSON content type returns `415`.
  Invalid JSON or invalid UTF-8 returns `400`.

### M2 — Inbound signature verification

*As a tenant, I want forged or replayed webhooks rejected, so my endpoints only see genuine events.*

- AC2.1 In `standard-webhooks` mode, a correctly signed request is accepted; a wrong signature, a missing
  header, or a timestamp outside ±`SIGNATURE_TOLERANCE_SECONDS` returns `401` with code `INVALID_SIGNATURE`.
- AC2.2 In `generic-hmac` mode, the signature is read from the configured header, with the configured prefix
  and encoding. If a timestamp header is configured, the tolerance window is enforced.
- AC2.3 Verification uses the raw request bytes. Re-serialized JSON with different whitespace fails.
- AC2.4 Signature comparison is constant-time (`crypto.timingSafeEqual`).
- AC2.5 A rejected request creates no Event row and no job.

### M3 — Inbound deduplication

*As a tenant, when a provider retries a webhook I already accepted, I do not want it processed twice.*

- AC3.1 Two requests to the same source with the same external event id produce one Event row. The second
  returns `202` with `"status": "duplicate"` and the first event's `id`.
- AC3.2 Requests without an external event id are never deduplicated.
- AC3.3 The same external id on two different sources produces two events.

### M4 — Rate limiting

*As an operator, I want one tenant's traffic spike not to exhaust the system.*

- AC4.1 Within any 60-second sliding window, a tenant is allowed about `Tenant.ingestRateLimit` requests;
  further requests return `429` with a `Retry-After` header in seconds.
- AC4.2 Concurrent requests cannot exceed the limit by racing (the check-and-increment is atomic).
- AC4.3 If Redis is unreachable, the limiter fails open and the request is accepted.
- AC4.4 Requests with invalid signatures do not consume the tenant's quota.

### M5 — Fan-out

*As a tenant, one event reaches every destination I connected to its source.*

- AC5.1 An event on a source with N enabled connections whose filters match creates N `Delivery` rows and
  the Event becomes `FANNED_OUT` with `deliveryCount = N`.
- AC5.2 Disabled connections and connections to disabled destinations create no Delivery.
- AC5.3 Running the fan-out job twice for one event creates each Delivery once.
- AC5.4 An event with zero matching connections becomes `FANNED_OUT` with `deliveryCount = 0`.

### M6 — Filter rules

*As a tenant, I route only the events a destination cares about.*

- AC6.1 Every example in [FILTER-RULES.md](FILTER-RULES.md#examples) evaluates as documented.
- AC6.2 A filter that violates a limit or the schema is rejected at connection create/update with `400`.
- AC6.3 Evaluation never throws; a stored filter that is somehow invalid is treated as "no match" and logged.

### M7 — Delivery with retries

*As a tenant, a temporary outage of my endpoint does not lose events.*

- AC7.1 A `2xx` response marks the Delivery `SUCCEEDED` after one attempt.
- AC7.2 `408`, `429`, `5xx`, timeouts, and network errors mark it `RETRYING` and schedule another attempt.
- AC7.3 Any other `4xx` (and any `3xx`) marks it `DEAD` immediately with no further attempts.
- AC7.4 After `DELIVERY_MAX_ATTEMPTS` failed attempts the Delivery is `DEAD` with `deadReason = RETRIES_EXHAUSTED`.
- AC7.5 Retry delays follow the formula in [QUEUES.md](QUEUES.md#backoff). `Retry-After` on `429`/`503` is honored up to the cap.
- AC7.6 Every attempt is recorded as a `DeliveryAttempt` with status code or error code, duration, and
  the truncated response body.

### M8 — Outbound signing

*As a receiver, I can verify that a request came from hookdeck-lite and was not tampered with.*

- AC8.1 Every outbound request carries `webhook-id`, `webhook-timestamp`, and `webhook-signature`.
- AC8.2 The official `standardwebhooks` library verifies our signature with the destination's secret.
- AC8.3 `webhook-id` is identical across all attempts and replays of the same event; `webhook-timestamp`
  is the send time of each attempt.

### M9 — SSRF protection

*As an operator, tenants cannot use the gateway to reach my internal network.*

- AC9.1 Creating or updating a destination whose URL resolves to a blocked range returns `422`.
- AC9.2 At delivery time, the resolved IP is checked again and the connection is made to that exact IP.
- AC9.3 Redirects are not followed. Only `http` and `https` are allowed.
- AC9.4 Hosts in `SSRF_ALLOWLIST` bypass the range check and nothing else.
- AC9.5 Every case in the [security test checklist](SECURITY.md#security-test-checklist) passes.

### M10 — Dead letters and replay

*As a tenant, I can see what failed and send it again once my endpoint is fixed.*

- AC10.1 `DEAD` deliveries are listed by `GET /api/v1/deliveries?status=DEAD` and shown in the dashboard.
- AC10.2 `POST /api/v1/deliveries/{id}/replay` on a `DEAD` or `SUCCEEDED` delivery creates a new Delivery
  with `trigger = REPLAY` and `replayOfId` set, and returns `202`.
- AC10.3 The original Delivery and its attempts are unchanged after a replay.
- AC10.4 Replaying a `PENDING` or `RETRYING` delivery returns `409`.

### M11 — Sweeper

*As an operator, a Redis outage delays events but does not lose them.*

- AC11.1 An Event left in `RECEIVED` for longer than `SWEEPER_STUCK_AFTER_MS` with no job is re-enqueued and delivered.
- AC11.2 A Delivery left in `PENDING`, or in `RETRYING` past its `nextAttemptAt`, with no job is re-enqueued.
- AC11.3 Sweeping an item that already has a job changes nothing.

### M12 — Management API

- AC12.1 Each resource supports the operations in [openapi.yaml](api/openapi.yaml), with cursor pagination on lists.
- AC12.2 Every query is scoped to the caller's tenant. Another tenant's resource id returns `404`.
- AC12.3 Errors use the single error shape defined in the OpenAPI document.
- AC12.4 Secrets are never returned by list or get endpoints.

### M13 — API-key auth

- AC13.1 Requests to `/api/v1/*` without a valid `Authorization: Bearer <key>` return `401`.
- AC13.2 Keys are stored as SHA-256 hashes; the plaintext is shown once, by the seed script.
- AC13.3 A revoked key returns `401`.

### M14 — Dashboard

- AC14.1 After entering a valid API key, the events list loads and can be filtered by source and status.
- AC14.2 The event detail page shows each delivery, its attempts in order, and request/response details.
- AC14.3 A new event or attempt appears in the live view within 2 seconds without a page reload.
- AC14.4 The replay button on a `DEAD` delivery creates a replay and the new delivery appears.

### M15 — Observability

- AC15.1 `GET /health` returns `200` whenever the process is running.
- AC15.2 `GET /ready` returns `200` only when Postgres and Redis both respond; otherwise `503` naming the failed check.
- AC15.3 Pipeline log lines include `tenantId`, `eventId`, and `deliveryId` where applicable, and no secrets.

### M16 — Secrets at rest

- AC16.1 Source and destination secrets are stored as AES-256-GCM ciphertext; the database never holds plaintext.
- AC16.2 Tampering with a stored ciphertext or moving it to another tenant's row makes decryption fail.
- AC16.3 The API and worker refuse to start without a valid 32-byte `SECRETS_MASTER_KEY`.

## Non-functional requirements

| ID | Requirement | How it is measured |
|---|---|---|
| NFR1 | **Ingestion ACK p95 < 20 ms** | `tools/loadtest` with the conditions below |
| NFR2 | **Zero lost events when the worker crashes mid-delivery** | Integration test: kill the worker during an attempt; every accepted event still reaches `SUCCEEDED` or `DEAD`, with at most duplicate sends |
| NFR3 | **The full retry schedule completes within 3 h 6 min** at default settings when the destination sends no `Retry-After` | Derived from the formula; a test with scaled-down settings asserts the bound. See [QUEUES.md](QUEUES.md#worked-delay-table) |
| NFR4 | Zero lost events when Redis is unavailable for up to 5 minutes during ingestion | Integration test: stop Redis, ingest, start Redis; all events are delivered |
| NFR5 | Live stream latency under 2 s from attempt to dashboard | Manual check on Day 3, e2e assertion on Day 4 |
| NFR6 | `packages/shared` and `packages/core` line coverage ≥ 90 % | Vitest coverage in CI |

### NFR1 measurement conditions

- Machine: the lead's Windows laptop. The README records CPU, RAM, and OS build next to the numbers.
- API runs natively on the host with `NODE_ENV=production` and `LOG_LEVEL=warn`. Postgres and Redis run in
  Docker Desktop. The worker is running, with one connection to the mock receiver, so the pipeline is live.
- Request: `POST /in/{sourceSlug}`, 1 KiB JSON body, source in `standard-webhooks` mode, a fresh
  `webhook-id` and valid signature per request.
- Load: `autocannon` with 10 connections, 5 s warm-up, 30 s measured run. The load-test tenant's
  `ingestRateLimit` is raised so no request is rate limited.
- Pass: p95 < 20 ms and zero non-`2xx` responses. p50 and p99 are recorded too.
- If `autocannon` does not report p95 directly (`UNVERIFIED`), record p97.5, which is stricter.

### NFR3 bound

With the defaults (`DELIVERY_MAX_ATTEMPTS=10`, `BACKOFF_BASE_MS=30000`, `BACKOFF_CAP_MS=3600000`,
`DELIVERY_TIMEOUT_MS=15000`) the nine waits total at most 3 h 3 min 30 s and the ten attempts take at most
2 min 30 s. The expected total is about half the wait bound, roughly 1 h 32 min. If the destination sends
`Retry-After` on every response, each wait can reach the cap, so the absolute bound is 9 h plus attempt time.

## Out-of-scope risks we accept

- A single Postgres instance is a single point of failure for ingestion.
- The dashboard stores the API key in `sessionStorage`. This is acceptable for a demo-grade auth model.
- Free-tier hosting may sleep the API. See [ADR-0016](adr/0016-deployment.md).
