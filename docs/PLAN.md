# Build plan (4 days)

Day 1 includes the documentation session that produced this file. Each day ends with something the lead
can run and see, an entry in [LEARNING-LOG.md](LEARNING-LOG.md), and all checks green.

How to use this plan:

- Start each day by pasting that day's kickoff prompt into a new session. Save the prompt you used in
  `prompts/` (for example `prompts/02-day1-scaffold.md`).
- If a day overruns, cut from the [cut list](#cut-list), top first. Do not borrow time from tests.
- Scope is defined by [PRD.md](PRD.md). Names are defined by [ARCHITECTURE.md](ARCHITECTURE.md#canonical-names).

| Day | Theme | Ends with |
|---|---|---|
| 1 | Docs, scaffold, data, filter engine, ingestion | A signed webhook returns `202` and is in Postgres with a job in Redis |
| 2 | Worker pipeline, security, replay | A webhook is delivered to the mock receiver, retried, dead-lettered, and replayed |
| 3 | Management API and dashboard | The whole flow is visible and controllable in the browser, live |
| 4 | Tests, load test, CI, deploy, README | A public demo, green CI, and measured numbers in the README |

## Day 1 — scaffold, data, filter engine, ingestion

### Tasks, in order

1. **Scaffold the monorepo.** pnpm workspace, Turborepo pipeline (`build`, `typecheck`, `lint`, `test`,
   `test:integration`, `dev`), shared `tsconfig`, ESLint flat config, Prettier, Vitest. Create every
   package and tool folder from [ADR-0002](adr/0002-service-split.md) with a minimal `package.json`.
   Install with the pins in [ADR-0017](adr/0017-toolchain-versions.md).
2. **Resolve the Day 1 unverified items** ([list below](#unverified-items-to-check-on-day-1)) before
   building on them. Record each result in the learning log.
3. **docker-compose** with `postgres`, `redis` (started with `--maxmemory-policy noeviction`), and
   `mock-receiver`. Add `.env.example`. Postgres init creates both `hookdeck` and `hookdeck_test`.
4. **`packages/database`**: Prisma schema from [DATA-MODEL.md](DATA-MODEL.md), first migration, exported
   client with the `pg` adapter, seed script (demo tenant, API key from `SEED_API_KEY`, one
   `standard-webhooks` source, one destination pointing at the mock receiver, one connection; plus a
   load-test tenant with a very high `ingestRateLimit`).
5. **`packages/shared`**: entity types, Zod schemas for API inputs and `VerificationConfig`,
   `StreamMessage`, and the **filter engine** with every example in
   [FILTER-RULES.md](FILTER-RULES.md#examples) as a test.
6. **`packages/core`, the parts ingestion needs**: env parsing with Zod, pino logger factory, Redis
   connection factories, queue names and job types, HMAC sign/verify for both modes, secret encryption,
   the rate-limiter Lua script and wrapper. Unit tests for HMAC and encryption.
7. **`tools/mock-receiver`, minimal**: `POST /hook/:bucket` returning a status chosen by query parameter,
   and `GET /health`. The full control API comes on Day 2.
8. **`apps/api`**: bootstrap (Fastify adapter, `rawBody: true`, body limit, CORS with explicit methods,
   shutdown hooks, request ids, error filter producing the standard error shape), `/health`, `/ready`,
   and `POST /in/{sourceSlug}` end to end: source cache → verify → rate limit → insert (dedupe) →
   enqueue → publish `event.received` → `202`.
9. **A helper script** `send-webhook` (tsx) that signs and posts a sample event, for demos and manual tests.
10. **Fill in the Commands section of `CLAUDE.md`**, and append the Day 1 entry to the learning log.

### Acceptance criteria

- `pnpm install`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass from a clean clone on Windows.
- PRD criteria AC1.1–AC1.6, AC2.1–AC2.5, AC3.1–AC3.3, AC4.1–AC4.4, AC6.1–AC6.2, AC15.1–AC15.2, and
  AC16.1–AC16.3 are covered by tests that pass.
- Filter engine: every example and every "rejected by validation" row is a passing test; coverage of
  `packages/shared` ≥ 95 % lines.
- `LEARN:` comments exist for: raw body, timing-safe compare, `jobId` idempotency, Lua atomicity,
  AES-GCM nonce and tag.
- No `UNVERIFIED` item from the Day 1 list remains unresolved.

### Demo checkpoint

```
docker compose up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
pnpm send-webhook                     -> 202 {"id": "...", "status": "accepted"}
pnpm send-webhook --same-id           -> 202 {"status": "duplicate"}
pnpm send-webhook --bad-signature     -> 401 INVALID_SIGNATURE
```

Then look: the Event row in Postgres (`pnpm db:studio`), the job in Redis
(`docker compose exec redis redis-cli keys "hdl:*"`), and `GET /ready`. Stop Redis
(`docker compose stop redis`), send again, and see `202` with the Event stored and `/ready` at `503`.

### Kickoff prompt

```text
You are implementing Day 1 of hookdeck-lite. The complete spec is in docs/. Read these first, in order:
CLAUDE.md, docs/README.md, docs/PLAN.md (Day 1 section and "Unverified items"), docs/ARCHITECTURE.md,
docs/DATA-MODEL.md, docs/FILTER-RULES.md, docs/SECURITY.md (inbound verification, secret encryption,
rate limiting, API key handling, input limits), docs/adr/0017-toolchain-versions.md.

Follow CLAUDE.md exactly: commenting rules with `// LEARN:` tags, the ADR rule, the definition of done.
I am comfortable with Node, TypeScript and React; BullMQ, Redis queues and webhooks are new to me. I will
review the code and must be able to explain it, so prefer readable code over clever code.

Do the Day 1 tasks from docs/PLAN.md in the listed order:
1. Scaffold the monorepo (pnpm workspaces + Turborepo) with every app, package and tool folder.
   Use the version pins in ADR-0017. Never run `pnpm add prisma` without a version: pin prisma@7.
2. Resolve every item under "Unverified items to check on Day 1" before depending on it. Check the
   installed package's types or the official docs; do not rely on memory. Tell me what you found.
3. docker-compose (postgres, redis with noeviction, mock-receiver) and .env.example.
4. packages/database: Prisma schema from DATA-MODEL.md, migration, pg adapter client, seed.
5. packages/shared: types, Zod schemas, and the filter engine with every example in FILTER-RULES.md
   as a test (matching and non-matching), plus the rejected filters.
6. packages/core: env parsing, logger, Redis connections, queue names and job types, HMAC sign/verify
   (standard-webhooks and generic-hmac), secret encryption, rate-limiter Lua script. Unit tests.
7. tools/mock-receiver, minimal version.
8. apps/api: bootstrap, /health, /ready, and POST /in/{sourceSlug} end to end as in sequence diagram 1.
9. A send-webhook helper script.
10. Fill in the Commands section of CLAUDE.md and append the Day 1 entry to docs/LEARNING-LOG.md.

Constraints:
- I develop on Windows with Docker Desktop. No bash-only scripts in package.json; use tsx/Node scripts.
- Use the canonical names in docs/ARCHITECTURE.md#canonical-names. Do not rename anything.
- Do not build worker processors, the management API, or the dashboard today.
- If a doc is wrong or something is impossible, stop and tell me; propose an ADR instead of quietly
  deviating. If you must choose something the docs do not cover, write an ADR in the same change.
- Commit in small steps with clear messages, one per numbered task.

When done, report: what was built, the result of each acceptance criterion in the Day 1 section
(pass/fail with evidence), anything skipped, what each unverified item turned out to be, and the exact
commands for the Day 1 demo checkpoint.
```

## Day 2 — worker pipeline, security, replay

### Tasks, in order

1. **Resolve the Day 2 unverified items** (BullMQ `failed` listener semantics, duplicate `jobId`
   behaviour for finished jobs, undici `connect.lookup`).
2. **`packages/core`, the rest**: `computeBackoffDelay`, `parseRetryAfter`, `classifyResponse`,
   the SSRF address checker and the SSRF-safe HTTP client, the stream publisher and subscriber.
   Unit tests for all of them.
3. **`tools/mock-receiver`, full version**: the control API and programmatic interface specified in
   [TESTING.md](TESTING.md#the-mock-receiver).
4. **`apps/worker`**: `main.ts` wiring (connections, both Workers, sweeper, shutdown), the fan-out
   processor, the delivery processor with outbound signing, the `failed` listeners, the sweeper.
   Follow [QUEUES.md](QUEUES.md) step by step.
5. **`apps/api`**: `ApiKeyGuard` and `GET /api/v1/whoami`; read endpoints for events and deliveries
   (list, detail, attempts) with cursor pagination; `POST /api/v1/deliveries/{id}/replay`;
   `POST /api/v1/destinations/{id}/replay-dead`.
6. **Security tests**: every line of the [security test checklist](SECURITY.md#security-test-checklist).
7. **Integration tests** for fan-out idempotency, retry → success, retries exhausted → `DEAD`,
   permanent failure → `DEAD`, `Retry-After`, replay, and the sweeper (Event and Delivery cases).
8. Learning-log entry.

### Acceptance criteria

- PRD criteria AC5.1–AC5.4, AC6.3, AC7.1–AC7.6, AC8.1–AC8.3, AC9.1–AC9.5, AC10.1–AC10.4,
  AC11.1–AC11.3, AC13.1–AC13.3, and AC12.2 (for the endpoints built today) are covered by passing tests.
- Every checklist item `SEC-*` has at least one passing test whose name contains the id.
- The backoff test asserts the exact ceilings of the [worked delay table](QUEUES.md#worked-delay-table).
- Coverage of `packages/core` ≥ 90 % lines.
- `LEARN:` comments exist for: jitter, IP pinning, stalled jobs, at-least-once duplicates,
  `maxRetriesPerRequest: null`, compare-and-set updates.
- Stopping the worker with `Ctrl+C` during a delivery finishes the attempt and exits cleanly.

### Demo checkpoint

With the demo backoff profile (`BACKOFF_BASE_MS=1000`, `BACKOFF_CAP_MS=10000`, `DELIVERY_MAX_ATTEMPTS=5`):

1. `pnpm send-webhook` → the mock receiver logs the delivery with valid `webhook-*` headers.
2. Script the mock receiver to fail twice then succeed → the worker log shows two retries with growing
   delays, then success; `GET /api/v1/deliveries/{id}` shows three attempts.
3. Script it to always return `503` → after five attempts the delivery is `DEAD`.
4. Script it back to `200`, call the replay endpoint → a new delivery with `trigger: REPLAY` succeeds.
5. Create a destination row pointing at `http://169.254.169.254/` (directly in the database, to bypass
   create-time validation) → the attempt is `SSRF_BLOCKED` and the delivery is `DEAD`.
6. Stop Redis, send three webhooks, start Redis → within about 45 s all three are delivered.

### Kickoff prompt

```text
You are implementing Day 2 of hookdeck-lite: the worker pipeline, security, and replay.
Read first: CLAUDE.md, docs/PLAN.md (Day 2 section), docs/QUEUES.md (all of it; it is the spec for
today), docs/SECURITY.md (outbound signing, SSRF protection, the security test checklist),
docs/ARCHITECTURE.md (sequence diagrams 2, 3, 4, 6 and the failure-mode table), docs/TESTING.md
(the mock receiver and integration sections), docs/adr/0004 to 0009, and the Day 1 entry in
docs/LEARNING-LOG.md. Then read the code that exists in packages/ and apps/api.

Do the Day 2 tasks from docs/PLAN.md in order:
1. Resolve the Day 2 unverified items against installed package types or official docs, with a small
   test where the plan asks for one. Tell me what you found.
2. packages/core: computeBackoffDelay (random source injected), parseRetryAfter, classifyResponse,
   the SSRF address checker (exact CIDR list in SECURITY.md) and the SSRF-safe HTTP client with IP
   pinning, the stream publisher and subscriber. Unit-test each.
3. tools/mock-receiver: full control API as specified in TESTING.md.
4. apps/worker in plain TypeScript with BullMQ directly (no NestJS): main.ts, fan-out processor,
   delivery processor with Standard Webhooks signing, failed listeners, sweeper, graceful shutdown.
   Implement the numbered steps in QUEUES.md literally. Postgres is the attempt counter of record.
5. apps/api: ApiKeyGuard, GET /api/v1/whoami, read endpoints for events and deliveries with cursor
   pagination, single replay and bulk replay, all matching docs/api/openapi.yaml.
6. Turn every line of the security test checklist into at least one test named with its SEC id.
7. Integration tests listed in the Day 2 section.
8. Append the Day 2 entry to docs/LEARNING-LOG.md.

Constraints:
- BullMQ is v6: ioredis is a peer dependency, backoffStrategy goes in Worker settings, use
  UnrecoverableError for permanent failures. Do not copy v4/v5 patterns from memory.
- Every status update on a Delivery must include WHERE status IN ('PENDING','RETRYING'). Fan-out uses
  the compare-and-set on Event.status. Explain both with LEARN comments.
- No outbound HTTP anywhere except through the SSRF-safe client.
- Windows: handle SIGINT as well as SIGTERM. No bash-only scripts.
- Tests must not sleep for real backoff times: use the integration-test backoff profile in QUEUES.md.
- If the spec is wrong or ambiguous, stop and tell me; write an ADR for any new cross-cutting decision.

When done, report: what was built, pass/fail for each Day 2 acceptance criterion with evidence, the
SEC checklist as a table of id -> test name, anything skipped or not verified, and the exact steps for
the Day 2 demo checkpoint.
```

## Day 3 — management API and dashboard

### Tasks, in order

1. **`apps/api`, the remaining endpoints**: CRUD for sources, destinations (with create-time SSRF
   validation and secret generation), and connections (with filter validation); rotate-secret;
   `GET /api/v1/metrics/summary` and `/timeseries` using the queries in
   [DATA-MODEL.md](DATA-MODEL.md#dashboard-metrics-queries); `GET /api/v1/stream` (SSE with keep-alive,
   one shared Redis subscriber, reference-counted per tenant). Integration tests for tenant isolation
   and stream isolation.
2. **`apps/web` foundation**: Next.js App Router, Tailwind, TanStack Query, a typed API client built on
   the `shared` schemas, the "enter API key" screen (`whoami`, `sessionStorage`), layout and navigation.
3. **Events list**: filters by source and status, cursor "load more", live insertion of new events.
4. **Event detail**: stored request (headers, query, body as text), deliveries, and for each delivery an
   **attempts timeline** with status code, duration, error, request and response details.
5. **Live stream**: the fetch-based SSE client with reconnect and refetch-on-reconnect; a live activity view.
6. **Dead-letter view** with single replay and "replay all DEAD for this destination".
7. **Metrics page**: summary tiles and a deliveries-over-time chart.
8. **Minimal CRUD** screens for sources, destinations, and connections. Show a destination's signing
   secret once, on creation.
9. **Filter-rule tester**: edit a filter as JSON, pick a stored event or paste a payload, and see
   match or no match computed in the browser by the `shared` engine, with validation errors inline.
10. Learning-log entry.

### Acceptance criteria

- PRD criteria AC12.1–AC12.4 and AC14.1–AC14.4 hold; AC12 is covered by tests, AC14 by the demo.
- The API matches [openapi.yaml](api/openapi.yaml) for every endpoint (shapes, status codes, error codes).
- A new event appears in the events list within 2 seconds without a reload (NFR5).
- The filter tester and the worker agree on every example in FILTER-RULES.md (same function, same result).
- Payloads and response bodies are rendered as text. No `dangerouslySetInnerHTML` anywhere.
- `LEARN:` comments exist for: SSE keep-alive, why `fetch` instead of `EventSource`, cursor pagination.
- `apps/web` imports nothing from `@hdl/core` or `@hdl/database`.

### Demo checkpoint

Open the dashboard, enter the seeded API key, and with the demo backoff profile:

1. Run `pnpm send-webhook` a few times and watch events and attempts appear live.
2. Open an event and read its attempts timeline.
3. Script the mock receiver to fail; watch a delivery go `RETRYING` then `DEAD`; fix the receiver;
   press Replay; watch the new delivery succeed.
4. Create a new destination and connection with a filter; test the filter against a stored event;
   send a matching and a non-matching webhook and see one delivered and one filtered.
5. Open the metrics page and see the success rate and latency percentiles change.

### Kickoff prompt

```text
You are implementing Day 3 of hookdeck-lite: the rest of the management API and the dashboard.
Read first: CLAUDE.md, docs/PLAN.md (Day 3 section), docs/api/openapi.yaml (the contract for
everything today), docs/DATA-MODEL.md (metrics queries, cursor pagination), docs/ARCHITECTURE.md
(sequence diagram 5), docs/adr/0011-live-stream.md, docs/adr/0013-auth-scope-cut.md,
docs/FILTER-RULES.md, docs/learning/reliability-patterns.md#server-sent-events, and the Day 1 and
Day 2 entries in docs/LEARNING-LOG.md. Then read the existing code.

Do the Day 3 tasks from docs/PLAN.md in order:
1. API: CRUD for sources, destinations (SSRF validation at create/update, signing secret returned
   once), connections (filter validated with parseFilter); rotate-secret; metrics summary and
   timeseries with $queryRaw tagged templates; GET /api/v1/stream as SSE with a 15 s keep-alive
   comment and one shared Redis subscriber. Integration tests for tenant and stream isolation.
2. apps/web: Next.js App Router used as a client-side app, Tailwind, TanStack Query, typed API client
   using @hdl/shared schemas, API-key screen using GET /api/v1/whoami and sessionStorage.
3. Events list with filters and live updates. 4. Event detail with the attempts timeline.
5. Fetch-based SSE client with reconnect and refetch. 6. Dead-letter view with single and bulk replay.
7. Metrics page. 8. Minimal CRUD screens. 9. Filter-rule tester using the shared engine in the browser.
10. Append the Day 3 entry to docs/LEARNING-LOG.md.

Constraints:
- I know React well. Keep the dashboard simple and readable: plain components, no state library
  beyond TanStack Query, no design system I have to learn. Clean and functional beats fancy.
- The browser cannot use EventSource (no Authorization header): read the stream with fetch.
- Render all payloads, headers and response bodies as text. Never inject HTML.
- apps/web may import only from @hdl/shared. packages/shared must stay browser-safe.
- On Fastify, CORS must list methods explicitly (GET, HEAD, POST, PATCH, DELETE).
- Every API response must match docs/api/openapi.yaml. If the contract needs to change, update the
  YAML in the same change and tell me.
- If you fall behind, cut from the cut list in docs/PLAN.md, top first, and tell me what you cut.

When done, report: what was built, pass/fail for each Day 3 acceptance criterion, what was cut,
anything not verified in a real browser, and the steps for the Day 3 demo checkpoint.
```

## Day 4 — tests, load test, CI, deploy, README

### Tasks, in order

1. **End-to-end tests** (API + worker + Postgres + Redis + mock receiver in one test process or as child
   processes): the happy path, and failure → `DEAD` → replay. Scenarios in
   [TESTING.md](TESTING.md#end-to-end-tests).
2. **Resilience tests**: worker killed mid-delivery (NFR2), Redis stopped during ingestion (NFR4),
   scaled-down retry schedule bound (NFR3).
3. **Fill coverage gaps** to the targets in [TESTING.md](TESTING.md#coverage-targets).
4. **`tools/loadtest`**: the autocannon script under the [NFR1 conditions](PRD.md#nfr1-measurement-conditions).
   Run it, record p50/p95/p99, requests per second, and the machine in the README.
5. **Dockerfiles** for `api` and `worker` (multi-stage, pruned to one app, non-root user, exec-form
   `CMD`), and a compose profile that runs the whole system in containers.
6. **GitHub Actions**: install → lint → typecheck → unit tests → integration and e2e tests with Postgres
   and Redis service containers. Cache pnpm and Turborepo.
7. **Deploy**: `render.yaml` Blueprint (api, worker, Postgres, Key Value with `noeviction`, and the mock
   receiver as a public demo destination), migrations as a pre-deploy command, production env vars
   (`SSRF_ALLOWLIST` empty), then the dashboard on Vercel. Run the smoke test against the deployment.
8. **Final README**: quickstart, measured numbers, screenshots or a short recording, the architecture
   diagram, links, "How this was built", license.
9. Final learning-log entry and a last consistency check of docs against code.

### Acceptance criteria

- Both e2e tests pass locally and in CI.
- NFR2, NFR3, and NFR4 each have a passing automated test.
- NFR1 is measured and recorded in the README with its conditions, whatever the result. If p95 is 20 ms
  or more, the README says so and lists what was tried.
- Coverage meets the targets, enforced by Vitest thresholds in CI.
- CI is green on `main`.
- A fresh clone can go from nothing to a delivered webhook using only the README quickstart.
- The deployed API answers `/health`; a webhook sent to the deployed source reaches the deployed mock
  receiver and appears in the deployed dashboard.

### Demo checkpoint

1. Open the public dashboard URL, enter the demo API key.
2. Send a webhook to the public ingestion URL with the helper script.
3. Watch it arrive, fan out, and be delivered, live.
4. Show the green CI run and the latency table in the README.

### Kickoff prompt

```text
You are implementing Day 4 of hookdeck-lite: tests, load test, CI, deployment, and the final README.
Read first: CLAUDE.md, docs/PLAN.md (Day 4 section, cut list, open questions), docs/TESTING.md,
docs/PRD.md (non-functional requirements and NFR1 measurement conditions),
docs/adr/0014-testing-strategy.md, docs/adr/0016-deployment.md, docs/QUEUES.md (graceful shutdown,
in-flight jobs on deploy), and all entries in docs/LEARNING-LOG.md. Then read the existing code and tests.

Do the Day 4 tasks from docs/PLAN.md in order:
1. Two end-to-end tests: happy path, and failure -> DEAD -> replay, as specified in TESTING.md.
2. Resilience tests for NFR2 (worker killed mid-delivery), NFR4 (Redis down during ingestion) and
   NFR3 (retry schedule bound with scaled-down settings).
3. Fill coverage gaps to the targets in TESTING.md and enforce thresholds.
4. tools/loadtest with autocannon under the exact NFR1 conditions. Run it and give me the raw output.
   Record p50/p95/p99 and the conditions in README.md. Report the real numbers even if the target is
   missed; do not weaken durability (no async commit, no skipping the insert) to hit it.
5. Dockerfiles for api and worker (multi-stage, non-root, exec-form CMD) and a full compose profile.
6. GitHub Actions workflow with Postgres and Redis service containers.
7. render.yaml Blueprint and Vercel setup. Before deploying, read Render's current pricing and docs
   for the items marked UNVERIFIED in ADR-0016 and tell me the real monthly cost. Do not create paid
   resources, change DNS, or push secrets without asking me first.
8. Final README: quickstart, measured numbers, screenshots, architecture diagram, how it was built.
9. Final learning-log entry; then compare docs against code and list every mismatch you find.

Constraints:
- Windows + Docker Desktop locally; Linux in CI. Scripts must work in both.
- Crash simulation must be cross-platform: spawn the worker as a child process and kill it.
- Never put real secrets in the repository. .env.example holds placeholders only.
- If you fall behind, cut from the cut list in docs/PLAN.md, top first, and tell me what you cut.
  Deployment is cuttable; the two e2e tests and the measured numbers are not.

When done, report: pass/fail for each Day 4 acceptance criterion with evidence, the load-test table,
the CI run link, deployed URLs, monthly cost, everything cut or left unverified, and the doc/code
mismatches.
```

## Cut list

Ranked. When a day overruns, drop from the top. Items above the line are stretch or Should features.

| Rank | Drop | Saves | What remains |
|---|---|---|---|
| 1 | Circuit breaker per destination (C1) | 3–4 h | Backoff and concurrency limits. It is not planned into any day; only start it if Day 4 finishes early |
| 2 | Payload transformations | n/a | Already a Won't. Listed so nobody starts it |
| 3 | Bulk replay (S1): endpoint and button | 1–2 h | Single replay |
| 4 | Retention job (C2), header forwarding (C3), management rate limiting (C4), key-rotation tooling (C5) | n/a | Documented only |
| 5 | Rotate destination secret (S5), auto-disable on `410` (S6) | 1 h | Delete and recreate the destination; `410` still goes `DEAD` |
| 6 | Metrics time-series chart | 1–2 h | Summary tiles |
| 7 | Dashboard CRUD forms (S4) | 2–3 h | Read-only lists; create resources with the seed script or the API |
| 8 | Filter-rule tester UI (S3) | 1–2 h | Filters still work; test them through the API |
| 9 | Public deployment (S7) | 2–4 h | `docker compose` quickstart, CI, and a recorded demo in the README |
| — | **Line. Below here are Musts; cutting one changes what the project claims.** | | |
| 10 | `generic-hmac` mode | 1–2 h | `standard-webhooks` and `none` |
| 11 | Dashboard live stream (keep the SSE endpoint, poll every 3 s in the UI) | 1–2 h | A dashboard that refreshes |

Never cut: durable ingestion and the sweeper, retries with backoff, `DEAD` and single replay, inbound
verification, outbound signing, the SSRF guard, the security checklist tests, the two e2e tests, and the
measured latency numbers.

## Open questions for the human lead

Things the docs session decided provisionally. Each has a default so work is not blocked.

| # | Question | Default if you say nothing | Where |
|---|---|---|---|
| 1 | **Hosting budget.** Render has no free background worker; free Postgres is deleted after 30 days; a free API sleeps after 15 minutes. Roughly $7, $14, or $30 per month? | $7: paid worker, everything else free | [ADR-0016](adr/0016-deployment.md) |
| 2 | **Toolchain pins.** Node 24 (installed, Maintenance LTS) or Node 26 (Active LTS since 2026-10-28)? TypeScript 6 (required by the NestJS 12 toolchain) instead of 7? | Node 24, TypeScript 6 | [ADR-0017](adr/0017-toolchain-versions.md) |
| 3 | **Replay keeps the same `webhook-id`.** A receiver that deduplicates will acknowledge and ignore a replay of something it already processed. That is the spec-conformant choice, but "replay" may suggest "force reprocess" to you | Same id | [ADR-0005](adr/0005-at-least-once-delivery.md) |
| 4 | **Retry schedule.** 10 attempts over at most about 3 hours. Your brief's example was "8 times over ~6 hours". Both are env settings; which default do you want to defend? | 10 attempts, 30 s base, 1 h cap | [QUEUES.md](QUEUES.md#worked-delay-table) |
| 5 | **Deletes are hard deletes that cascade.** Deleting a source or destination removes its events and deliveries. Soft delete would preserve history at the cost of `deletedAt` filters everywhere | Hard delete with a warning in the UI | [DATA-MODEL.md](DATA-MODEL.md#conventions) |
| 6 | **Only `application/json` is accepted.** Some providers can send form-encoded bodies | JSON only | [SECURITY.md](SECURITY.md#getting-the-raw-body) |
| 7 | **`generic-hmac` timestamp is optional.** Your brief asked for a timestamp in HMAC verification, but GitHub-style providers send none. Without it there is no replay window, only dedupe | Optional, documented as weaker | [ADR-0008](adr/0008-signatures-and-secrets.md) |
| 8 | **If NFR1 misses 20 ms on your laptop.** Docker Desktop on Windows adds a network hop to Postgres and Redis. Report honestly, or relax the target? | Report the real number; do not trade durability for it | [PRD.md](PRD.md#nfr1-measurement-conditions) |
| 9 | **Public demo destination.** Production blocks private addresses, so the demo needs a public receiver. Deploy the mock receiver as a free Render web service? | Yes | [ADR-0016](adr/0016-deployment.md) |

## Fixed decisions that were challenged

None of the sixteen fixed decisions turned out to be wrong or impossible. Four were refined; the
refinements are recorded in the ADRs and summarised here so they are not a surprise.

| Decision | Refinement | Why |
|---|---|---|
| 7 (mark `DEAD` when the job fails for the last time) | `DEAD` is written by the processor, in the same transaction as the last attempt, not in BullMQ's `failed` event. The event and the sweeper are backstops | A crash between the failure and the event handler would leave the Delivery `RETRYING` forever |
| 8 (HMAC plus a timestamp) | The timestamp is optional in `generic-hmac` | Open question 7 |
| 11 (SSE at `GET /api/v1/stream`) | The browser reads it with `fetch`, not `EventSource` | `EventSource` cannot send the `Authorization` header that decision 13 requires |
| 16 (Render or Fly.io, managed Postgres and Redis) | Render, with a cost caveat | Open question 1 |

Also noted, not changed: NestJS documentation recommends its new `NodeAdapter` from v12.3 and will make it
the default in v13. The Fastify adapter remains supported and is what decision 2 specifies
([ADR-0002](adr/0002-service-split.md)).

## Unverified items to check on Day 1

Everything the docs session could not confirm against a primary source. Each is marked `UNVERIFIED` where
it is used. The session for the listed day resolves it and records the answer in the learning log.

| # | Item | Day | How to check |
|---|---|---|---|
| U1 | The `pnpm-workspace.yaml` setting that allows Prisma's dependency build scripts in pnpm 12 | 1 | pnpm docs; `pnpm install` output |
| U2 | Vitest 5 with NestJS 12: whether DI needs the SWC plugin for decorator metadata | 1 | What `nest new` generates for an ESM project; a DI smoke test |
| U3 | `nestjs-pino` compatibility with NestJS 12 (else use Fastify's built-in pino logger) | 1 | Peer dependencies; a boot test |
| U4 | Prisma 7.10 config file name and the generated client's import path | 1 | `prisma init` output |
| U5 | Docker image tags `postgres:17-alpine`, `redis:8-alpine`, `node:24-alpine` exist | 1 | `docker pull` |
| U6 | ioredis 6 with BullMQ 6 (protocol default); fall back to ioredis 5 if there is friction | 1 | A queue add/process smoke test |
| U7 | The latest TypeScript 6.x version | 1 | `npm view typescript versions` |
| U8 | BullMQ worker `failed` listener fires on every failed attempt, not only the last | 2 | A test with `attempts: 3` |
| U9 | BullMQ ignores `add` for a `jobId` whose job is completed or failed but not yet removed | 2 | A test |
| U10 | `undici@8` `Agent` `connect.lookup` option shape (else `node:https` `lookup`) | 2 | undici types; SEC-SSRF-07 |
| U11 | Whether `autocannon` reports p95 (else record p97.5) | 4 | Its result object |
| U12 | Render prices, the Postgres major it provisions, and SSE connection behaviour | 4 | Render pricing and docs; the deployed service |
