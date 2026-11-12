# Testing

What is tested, at which level, and how the tests get their dependencies.
Decision record: [ADR-0014](adr/0014-testing-strategy.md).

## Test pyramid

```mermaid
flowchart TB
  E2E["End-to-end: 2 tests<br/>API + worker + Postgres + Redis + mock receiver"]
  INT["Integration: about 40–60 tests<br/>one app or package against real Postgres and Redis"]
  UNIT["Unit: about 200 tests<br/>pure functions, no I/O"]
  E2E --- INT --- UNIT
```

| Level | Scope | Speed | Runs with |
|---|---|---|---|
| Unit | One function or class, no network, no database | Milliseconds | `pnpm test` |
| Integration | One app or package with real Postgres and Redis; outbound HTTP goes to the in-process mock receiver | Seconds | `pnpm test:integration` |
| End-to-end | API and worker together, through public HTTP endpoints only | Tens of seconds | `pnpm test:integration` (same command, `*.e2e.test.ts` files) |

File naming: `*.test.ts` (unit), `*.int.test.ts` (integration), `*.e2e.test.ts` (end-to-end). Unit tests
sit next to the code. Integration and e2e tests sit in each app's `test/` folder.

## What is real and what is mocked

| Dependency | Unit | Integration and e2e |
|---|---|---|
| Postgres | Not used | **Real** (database `hookdeck_test`) |
| Redis | Not used | **Real** (separate database index, unique BullMQ prefix per file) |
| BullMQ | Not used | **Real** |
| Prisma | Not used | **Real** client |
| Outbound HTTP destination | Not used | **Mock receiver**, in-process, real sockets |
| DNS | **Stub resolver** injected into the SSRF checker | Real for `localhost`; stub for rebinding tests |
| Clock | **Injected** `now()` in tolerance, rate-limit, and backoff code | Real |
| Randomness | **Injected** `random()` in backoff | Real |
| Third-party providers | Not used | Not used |

Rules:

- Do not mock Prisma, ioredis, or BullMQ. If a test needs them, it is an integration test.
- Do not use fake timers with BullMQ. Its delays are enforced in Redis, not by Node timers. Shrink the
  configuration instead (the integration backoff profile in [QUEUES.md](QUEUES.md#worked-delay-table)).
- Functions that depend on time or randomness take them as parameters, so unit tests are deterministic.

## What each level covers

### Unit

| Package | Subject | Source of cases |
|---|---|---|
| `shared` | Filter engine: `parseFilter`, `evaluateFilter` | Every example and rejected filter in [FILTER-RULES.md](FILTER-RULES.md#examples), the missing-path table, the type rules, each limit |
| `shared` | Zod schemas for API inputs and `VerificationConfig` | Valid and invalid samples per schema |
| `core` | `computeBackoffDelay` | Ceilings of the [worked delay table](QUEUES.md#worked-delay-table) with `random = () => 0.999…`; zero with `random = () => 0`; cap; `Retry-After` as a floor and its own cap |
| `core` | `parseRetryAfter` | Seconds, HTTP date, past date, garbage, negative, missing |
| `core` | `classifyResponse` | Every row of the [classification table](QUEUES.md#response-classification) |
| `core` | HMAC sign and verify | `SEC-IN-01`–`10`, `SEC-IN-14`, `SEC-OUT-01` |
| `core` | Secret encryption | `SEC-ENC-01`–`05` |
| `core` | SSRF address checker and URL validation | `SEC-SSRF-01`–`07`, `12`, `13` |
| `core` | API key parsing and hashing | Format, prefix extraction, hash comparison |
| `api` | Cursor encode/decode, error mapping | Round trips and malformed cursors |

### Integration

| App | Subject | Covers |
|---|---|---|
| `api` | Ingestion endpoint | AC1.1–AC1.6, AC2.5, AC3.1–AC3.3, `SEC-IN-11`–`13`, `SEC-LIM-01` |
| `api` | Rate limiter against real Redis | AC4.1–AC4.4, `SEC-RL-01`–`06` |
| `api` | Auth and tenant isolation | AC13.1–AC13.3, AC12.2, `SEC-AUTH-01`–`05` |
| `api` | CRUD, pagination, error shape, secrets never returned | AC12.1, AC12.3, AC12.4, `SEC-ENC-06`–`07`, `SEC-SSRF-11` |
| `api` | Replay endpoints | AC10.2–AC10.4, bulk replay idempotency |
| `api` | Metrics queries against seeded data | Known inputs → exact `successRate`, p50, p95 |
| `api` | Probes | AC15.1–AC15.2 (Redis stopped → `/ready` 503, `/health` 200) |
| `worker` | Fan-out processor | AC5.1–AC5.4, AC6.3 |
| `worker` | Delivery processor | AC7.1–AC7.6, AC8.1–AC8.3, `SEC-OUT-02`–`04`, `SEC-SSRF-08`–`10` |
| `worker` | Sweeper | AC11.1–AC11.3, including "job in failed set → row marked terminal" |
| `worker` | Graceful shutdown | Active job finishes; process exits within the deadline |
| `worker` + `api` | Log hygiene | `SEC-LIM-04` |

### End-to-end tests

Both drive the system only through HTTP, as a user would.

**E2E-1: happy path**

1. Seed a tenant, a `standard-webhooks` source, a destination at the mock receiver, and a connection with a filter.
2. `POST /in/{sourceSlug}` with a signed, matching payload → `202`.
3. Poll `GET /api/v1/events/{id}` until `FANNED_OUT` with one delivery `SUCCEEDED`.
4. Assert on the mock receiver's recorded request: body byte-identical, `webhook-id` equals the event id,
   signature verifies with the official `standardwebhooks` package.
5. Send a non-matching payload → event `FANNED_OUT`, `deliveryCount = 0`, `filteredCount = 1`, receiver saw nothing.
6. Open the SSE stream before step 2 and assert it carried `event.received`, `delivery.created`, and
   `delivery.attempted` for the event.

**E2E-2: failure → DEAD → replay**

1. Script the mock receiver: always `503`.
2. Ingest a webhook. With the integration backoff profile (4 attempts), poll until the delivery is `DEAD`
   with `deadReason = RETRIES_EXHAUSTED` and four attempts, each `RETRYABLE_FAILURE`.
3. Assert the gaps between attempts never exceed the ceilings.
4. Script the receiver: `200`.
5. `POST /api/v1/deliveries/{id}/replay` → `202`, a new delivery with `trigger = REPLAY`.
6. Poll until the new delivery is `SUCCEEDED`. Assert the original is still `DEAD` with four attempts,
   and the replay carried the same `webhook-id`.
7. With a second event whose delivery is still `RETRYING`, `POST /api/v1/deliveries/{id}/replay` → `409`.

### Resilience tests (Day 4)

| NFR | Test |
|---|---|
| NFR2, worker crash | Start the worker as a child process. Script the receiver with a 2 s delay. Ingest 20 events. Kill the worker while requests are in flight. Start a new worker. Assert every delivery ends `SUCCEEDED` and the receiver saw each `webhook-id` at least once |
| NFR4, Redis outage | Stop Redis (`docker compose stop redis`, or in CI point the API at a closed port). Ingest 10 events → all `202`. Restore Redis. Assert all are delivered within `SWEEPER_STUCK_AFTER_MS + SWEEPER_INTERVAL_MS` plus margin |
| NFR3, schedule bound | With the integration profile and an always-failing receiver, assert the time from first to last attempt is under the sum of ceilings plus attempt time |

Killing a child process with `child.kill()` terminates it immediately on Windows and sends `SIGTERM` on
Linux; for a crash test use `child.kill('SIGKILL')`, which is forceful on both.

## The mock receiver

`tools/mock-receiver` is a small HTTP server that behaves as badly as it is told to. It is used three
ways: as a docker-compose service for demos, as a public demo destination in the deployment, and
in-process in tests.

### Delivery endpoint

`POST /hook/{bucket}`. A bucket is just a name; each has its own scenario and its own record of requests.

Without a scenario it returns `200 {"ok":true}`. Query parameters override the response for one request,
which is handy from the dashboard:

| Parameter | Effect |
|---|---|
| `status=503` | Respond with this status |
| `delayMs=2000` | Wait before responding |
| `retryAfter=5` | Add a `Retry-After` header (seconds) |
| `failRate=0.3` | Respond `500` with this probability, else `200` |
| `bodyBytes=1048576` | Respond with a body of this size |
| `redirectTo=http://127.0.0.1/` | Respond `302` with this `Location` |
| `hang=1` | Accept the connection and never respond |

Global chaos for demos, from the environment: `MOCK_FAIL_RATE`, `MOCK_LATENCY_MS`.

### Control API

| Request | Effect |
|---|---|
| `PUT /__control/buckets/{bucket}` | Set the bucket's scenario (below) and clear its recorded requests |
| `GET /__control/buckets/{bucket}/requests` | The requests received, oldest first |
| `DELETE /__control/buckets/{bucket}` | Remove the scenario and the record |
| `GET /health` | `200` |

```ts
interface Scenario {
  /** Consumed in order, one per request. */
  responses?: Array<{ status: number; retryAfter?: number; delayMs?: number; body?: string }>;
  /** Used when `responses` is exhausted or absent. Default: { status: 200 }. */
  default?: { status: number; retryAfter?: number; delayMs?: number; body?: string };
  /** If set, each recorded request gets `signatureValid`, checked with the standardwebhooks package. */
  verifySecret?: string;
}

interface RecordedRequest {
  receivedAt: string;
  headers: Record<string, string>;
  body: string;                    // exactly as received
  signatureValid?: boolean;
}
```

"Fail twice, then succeed": `{ "responses": [{ "status": 500 }, { "status": 503, "retryAfter": 1 }], "default": { "status": 200 } }`.

### In tests

```ts
import { createMockReceiver } from '@hdl/mock-receiver';

const receiver = await createMockReceiver().listen(0);          // random free port on 127.0.0.1
receiver.setScenario('orders', { responses: [{ status: 500 }], default: { status: 200 } });
const url = receiver.urlFor('orders');                          // http://127.0.0.1:<port>/hook/orders

// ... ingest, wait for the delivery to finish ...

expect(receiver.requests('orders')).toHaveLength(2);
await receiver.close();
```

The integration environment sets `SSRF_ALLOWLIST=127.0.0.1,localhost` so the worker may deliver to it.
SSRF tests that need the guard active construct the HTTP client with an empty allowlist explicitly.

Waiting for asynchronous outcomes: tests poll the database or the API with a helper
(`await eventually(() => …, { timeoutMs: 10_000, intervalMs: 50 })`). No fixed sleeps.

## Coverage targets

Line coverage, measured by Vitest with the v8 provider, enforced as thresholds in CI.

| Workspace | Lines | Branches | Why |
|---|---|---|---|
| `packages/shared` | ≥ 95 % | ≥ 90 % | Pure logic that decides routing. Cheap to test completely |
| `packages/core` | ≥ 90 % | ≥ 85 % | Security and reliability primitives. Mistakes here are silent |
| `apps/worker` | ≥ 80 % | ≥ 70 % | Mostly covered by integration tests |
| `apps/api` | ≥ 75 % | ≥ 65 % | Controllers are thin; integration tests cover behaviour |
| `packages/database` | none | none | Schema and seed; exercised by every integration test |
| `apps/web` | none | none | Verified by the Day 3 demo checklist. The logic it relies on lives in `shared` |
| `tools/*` | none | none | Test tooling |

Coverage is a floor, not the goal. The acceptance criteria in [PRD.md](PRD.md) and the
[security checklist](SECURITY.md#security-test-checklist) are the goal: each `AC` and `SEC` id appears in
at least one test name, so a search for the id finds its test.

## Getting Postgres and Redis

Integration tests read `DATABASE_URL` and `REDIS_URL` from the environment and nothing else. They do not
start containers.

### Locally (Windows with Docker Desktop)

```
docker compose up -d postgres redis
pnpm test:integration
```

- The compose Postgres creates two databases at first start: `hookdeck` (development) and `hookdeck_test`.
- `pnpm test:integration` loads `.env.test`, which points at `hookdeck_test` and Redis database index 1,
  sets the integration backoff profile, and sets `SSRF_ALLOWLIST=127.0.0.1,localhost`.
- A Vitest global setup applies migrations to `hookdeck_test` once (`prisma migrate deploy`) and checks
  that both services answer. If one does not, it fails immediately with
  "Postgres/Redis not reachable. Run: docker compose up -d postgres redis".
- Development data is never touched: different database, different Redis index, different BullMQ prefix.

### In CI (GitHub Actions)

The integration job declares service containers and sets the same two variables:

```yaml
services:
  postgres:
    image: postgres:17-alpine
    env: { POSTGRES_USER: hookdeck, POSTGRES_PASSWORD: hookdeck, POSTGRES_DB: hookdeck_test }
    ports: ['5432:5432']
    options: >-
      --health-cmd "pg_isready -U hookdeck" --health-interval 5s --health-timeout 5s --health-retries 10
  redis:
    image: redis:8-alpine
    ports: ['6379:6379']
    options: >-
      --health-cmd "redis-cli ping" --health-interval 5s --health-timeout 5s --health-retries 10
env:
  DATABASE_URL: postgresql://hookdeck:hookdeck@localhost:5432/hookdeck_test
  REDIS_URL: redis://localhost:6379/1
```

The same test code runs in both places. Service containers cannot be given a custom command, so CI's
Redis runs with its default eviction policy; that is acceptable for tests, which never fill memory.

### Isolation between tests

All tests share one Postgres and one Redis, so they isolate by data, not by container.

| Concern | Rule |
|---|---|
| Rows | Each test file creates its own tenant (random name) through a factory and only queries by that tenant. `afterAll` deletes the tenant, which cascades |
| Queues | Each test file uses a unique `BULLMQ_PREFIX` (`hdl-test-<random>`). `afterAll` closes its queues and workers and calls `queue.obliterate({ force: true })` |
| Rate-limit keys | Keyed by tenant id, so unique per file |
| Parallelism | Files run in parallel; tests within a file run in sequence. The Redis-outage test stops the shared Redis, so it is tagged and runs alone in a separate, serial Vitest project |
| Ports | The mock receiver and the API under test listen on port 0 (a free port chosen by the OS) |

## Cross-platform rules

The lead develops on Windows; CI is Linux. Everything must run on both.

- No shell syntax in `package.json` scripts: no `&&` chains that depend on a shell, no `rm -rf`, no
  `export VAR=`, no inline `VAR=value command`. Use `tsx scripts/<name>.ts`, Node's `--env-file` flag,
  Turborepo for sequencing, and `docker compose` subcommands.
- File paths are built with `node:path`. No hard-coded separators.
- Signals: `SIGTERM` is not delivered on Windows. Shutdown tests send `SIGINT` where the platform is
  Windows, or call the exported `shutdown()` function directly.
- Line endings: `.gitattributes` sets `* text=auto eol=lf`, so signatures over fixture files do not
  change between platforms.
- Fixture bodies used for signature tests are read as bytes, never through a text-mode transform.

## Definition of "tested"

A feature is tested when:

1. Its acceptance criteria and checklist ids each have a named test.
2. The test fails if the behaviour is removed. Check this once by breaking the code on purpose.
3. It passes three times in a row locally with `pnpm test:integration`. A flaky test is a failing test.
