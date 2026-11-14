# Learning log

One entry per milestone, appended at the end of each day's session
([the rule](../CLAUDE.md#the-learning-log-rule)). The purpose is that the lead can explain what was built
and why, without re-reading the code. Newest entry last.

## Entry template

```markdown
## YYYY-MM-DD — Milestone name (Day N)

### What was built
Three to six bullets. Name the files or modules, so they can be found.

### Concepts it relied on
Three to five concepts. One sentence each on how *this* code uses it, with a link to the learning doc.

### Gotchas found during implementation
What did not work as the docs or intuition suggested, and what the fix was. Include resolved
`UNVERIFIED` items (id, what was found). If a doc was wrong, say which, and that it was corrected.

### Questions I should be able to answer
Three to six interview-style questions about this milestone. Answers in one or two sentences.

### Deviations and follow-ups
Anything cut, skipped, or left unverified. ADRs written. Empty if none.
```

## Example entry

This entry shows the expected format and level of detail. It describes the documentation session, so it
is also the first real entry.

## 2026-11-12 — Documentation set (Day 1, part 1)

### What was built

- The full spec in `docs/`: PRD, architecture with six sequence diagrams and a failure-mode table, data
  model with a draft Prisma schema, queue spec, security spec with a test checklist, filter DSL spec,
  OpenAPI 3.1 contract, testing strategy, and the 4-day plan.
- Seventeen ADRs in `docs/adr/`, one per fixed decision plus toolchain pins.
- Four learning docs and a glossary in `docs/learning/`.
- `CLAUDE.md`, the working agreement for implementation sessions, and a README skeleton.

### Concepts it relied on

- **Outbox-lite.** The Event row doubles as the outbox record; a sweeper is the relay for leftovers.
  [reliability-patterns](learning/reliability-patterns.md#outbox-lite)
- **`jobId` idempotency.** Using the Event or Delivery id as the BullMQ job id makes every enqueue safe
  to repeat, which is what lets the sweeper be simple. [bullmq-101](learning/bullmq-101.md#job-ids)
- **At-least-once plus a stable id.** We may send twice; the `webhook-id` lets receivers ignore repeats.
  [webhooks-101](learning/webhooks-101.md#delivery-guarantees)
- **Full jitter.** Random delays between zero and an exponential ceiling prevent synchronized retries.
  [reliability-patterns](learning/reliability-patterns.md#backoff-and-jitter)
- **IP pinning.** Validate the resolved address inside the connection's own DNS lookup, so there is no
  second lookup to rebind. [ssrf](learning/ssrf-and-network-security.md#ip-pinning)

### Gotchas found during implementation

- **"Latest" was not safe.** `npm view prisma version` returned a Prisma 8 release candidate, and
  TypeScript 7.0 ships without the compiler API that the NestJS 12 toolchain needs. Versions are pinned
  in ADR-0017.
- **BullMQ 6 changed the install.** `ioredis` is now a peer dependency. Most tutorials still show v5.
- **`EventSource` cannot send an `Authorization` header.** The dashboard reads the SSE stream with `fetch`.
- **Fastify's CORS default omits `PATCH` and `DELETE`.** Methods must be listed explicitly.
- **`SIGTERM` is never delivered to Node on Windows.** Shutdown code handles `SIGINT` too.
- **BullMQ's built-in exponential backoff has a `jitter` option** but cannot see `Retry-After`, so the
  custom strategy is still needed.
- **Render has no free background worker**, and its free Postgres is deleted after 30 days.

### Questions I should be able to answer

- **Why insert into Postgres before enqueueing in Redis?** A `202` is a promise the event will not be
  lost. Postgres is durable; Redis can lose recent writes. If the enqueue fails, the sweeper repairs it.
- **Why does the processor compute the backoff delay instead of BullMQ?** It knows about `Retry-After`
  and must store `nextAttemptAt` exactly. It passes the delay to BullMQ through the error it throws.
- **Why is `DEAD` written by the processor and not by a `failed` event handler?** So the terminal status
  commits in the same transaction as the last attempt. A handler that runs afterwards could be lost in a crash.
- **Why does replay create a new Delivery?** To keep history immutable and metrics for past periods stable.
- **What is still unverified?** Twelve items, listed in `docs/PLAN.md`, each assigned to a day.

### Deviations and follow-ups

- ADR-0017 (toolchain pins) is `Proposed`: Node 24 and TypeScript 6 need the lead's confirmation.
- Nine open questions for the lead are in `docs/PLAN.md`.
- No fixed decision was reversed. Four were refined; see "Fixed decisions that were challenged" in the plan.

## 2026-11-12 — Scaffold, data, filter engine, ingestion (Day 1, part 2)

### What was built

- **The monorepo** (pnpm 12 + Turborepo): one version catalog in `pnpm-workspace.yaml`, a shared
  `tsconfig.base.json`, an ESLint flat config that enforces the package boundaries, and docker-compose
  with Postgres, Redis (`noeviction`) and the mock receiver.
- **`packages/database`**: the Prisma 7 schema and first migration, a client factory on the `pg` adapter,
  `isUniqueViolation()`, and an idempotent seed (`prisma/seed.ts`).
- **`packages/shared`**: API types, Zod schemas, and the filter engine (`src/filter/`), 168 tests.
- **`packages/core`**: `env.ts` (Zod-validated configuration), `logger.ts` (pino with redaction),
  `redis.ts` (four connection roles), `queues/` (names, payloads, factories, `enqueueFanout`),
  `crypto/hmac.ts` (sign and verify for both modes), `crypto/secret-encryption.ts` (AES-256-GCM
  envelopes), `crypto/api-key.ts`, `rate-limit/` (the Lua script and its wrapper), `stream/publisher.ts`.
- **`apps/api`**: `create-app.ts` (bootstrap shared by `main.ts` and the tests), one exception filter,
  `/health` and `/ready`, and `POST /in/:sourceSlug` (`ingest/ingest.controller.ts` for HTTP,
  `ingest/ingest.service.ts` for the pipeline, `ingest/source-cache.ts`,
  `infrastructure/fanout-producer.ts`).
- **Tools**: `tools/mock-receiver` (minimal, with its Dockerfile) and `scripts/send-webhook.ts`.

### Concepts it relied on

- **Fast ACK with a durable commit point.** The request verifies, rate-limits, INSERTs the Event, and
  only then touches Redis. A `202` therefore always means "in Postgres"; the enqueue is best effort.
  [webhooks-101](learning/webhooks-101.md#fast-ack), [outbox-lite](learning/reliability-patterns.md#outbox-lite)
- **Raw-body HMAC with a timing-safe compare.** The signature is checked over `request.rawBody`, the
  untouched bytes, and candidates are compared with `crypto.timingSafeEqual` after a length check.
  [raw body](learning/webhooks-101.md#raw-body), [timing-safe comparison](learning/webhooks-101.md#timing-safe-comparison)
- **Deduplication by a unique index.** There is no "SELECT, then INSERT". The INSERT either succeeds or
  hits the unique index on `(sourceId, externalEventId)`, and that error becomes `202 duplicate`. Ten
  concurrent copies of one webhook produce one row. [idempotency](learning/webhooks-101.md#idempotency)
- **`jobId` idempotency.** The fan-out job's id is the Event id, so the api (and later the sweeper) can
  add it without checking first. [job IDs](learning/bullmq-101.md#job-ids)
- **Lua atomicity.** The rate limiter reads two counters, decides, and increments inside one script, so
  50 concurrent requests against a limit of 10 let exactly 10 through.
  [Lua scripts](learning/bullmq-101.md#lua-scripts), [rate limiting](learning/reliability-patterns.md#rate-limiting-algorithms)
- **AES-GCM with AAD.** A fresh 12-byte nonce per encryption, a 16-byte auth tag, and
  `"{tenantId}:{purpose}"` as additional authenticated data, so a ciphertext moved to another row does
  not decrypt. [encrypting secrets at rest](learning/ssrf-and-network-security.md#encrypting-secrets-at-rest)

### Gotchas found during implementation

Unverified items (the table is also in [PLAN.md](PLAN.md#results)):

- **U1.** pnpm 12 uses `allowBuilds:` (package → true/false) in `pnpm-workspace.yaml`. `strictDepBuilds`
  is on by default, so an unreviewed build script fails the install with `ERR_PNPM_IGNORED_BUILDS`.
  Allowed: `@prisma/engines`, `prisma`, `esbuild`. Denied: `msgpackr-extract` (the JS fallback is used).
- **U2.** No SWC plugin. Vitest 5.1 on Vite 8 emits decorator metadata from `emitDecoratorMetadata`.
  Guard: `apps/api/src/di-metadata.test.ts`.
- **U3.** `nestjs-pino@5.3.1` declares NestJS 12 support and boots. It was still dropped, see below.
- **U4.** `prisma init` 7.10.1 writes `prisma7.config.ts`; the client is generated as TypeScript and
  imported from `./generated/prisma/client.js`.
- **U5.** `postgres:17-alpine`, `redis:8-alpine` and `node:24-alpine` all pull.
- **U6.** BullMQ 6 works on ioredis 6.0.0. Guard: `packages/core/test/bullmq-ioredis.int.test.ts`.
- **U7.** The latest TypeScript 6 is 6.0.3, pinned `~6.0.3` (typescript-eslint 8.72 supports `<6.1.0`).

Found on the way:

- **A BullMQ Queue created while Redis is down never recovers.** The constructor sends one `INFO`
  command. On the api's fail-fast connection that command is rejected at once, the Queue's init promise
  stays rejected, and every later `add()` hangs, even after Redis is back. Found by starting the api
  with Redis stopped. Fix: `FanoutProducer` creates the Queue only when the connection is `ready`.
  A test starts the api against a closed port, then opens a TCP proxy to the real Redis on that port.
  `docs/QUEUES.md` was extended.
- **`queue.add()` waits for the connection to be ready** unless `skipWaitingForReady: true` is set.
  Without it a Redis outage turns into a hanging `202`. Three settings are needed together:
  `enableOfflineQueue: false`, `maxRetriesPerRequest: 1`, `skipWaitingForReady: true`.
- **A Queue re-emits its connection's `error` events**, and an `error` event without a listener crashes
  Node. The factories in `core` attach one.
- **`nestjs-pino` was dropped for Fastify's built-in logger.** It keeps one process-wide `pino-http`
  instance (so several apps in one test process share the first app's logger), its request middleware
  did not fire in our setup, and NestJS middleware runs after Fastify's body parser, so a request that
  fails parsing had no request id. Fastify's own `genReqId` runs before everything and its logger never
  prints headers. `apps/api/src/common/nest-logger.ts` routes NestJS's own lines through pino.
  ADR-0015 allowed either option; its note was updated.
- **Fastify's `requestIdLogLabel` option is deprecated** in 5.12 in favour of
  `logController: new LogController({ requestIdLogLabel })`.
- **Fastify parser errors reach the NestJS exception filter** as `HttpException` with the original
  error as `cause` (checked by request). No separate Fastify error handler is needed.
- **Fastify has built-in parsers for `text/plain` and form bodies**, so "wrong content type" is only a
  Fastify `415` for types it does not know. The controller checks the content type too.
- **Fastify's JSON parser rejects a body with a `__proto__` key** (also through NestJS's `rawBody`
  parser; checked by request). It returns `400`. Left as is and written into `SECURITY.md` as a known limitation.
- **`TextDecoder` drops a leading byte-order mark by default.** `ignoreBOM: true` keeps it, which the
  byte-for-byte promise for `Event.body` needs.
- **An undecryptable source secret was first reported as `503`** because one `catch` covered both the
  database call and the decryption. Now only a Postgres failure is `503`; a bad stored secret is `500`.
- **pnpm 12 has a release-age gate.** Versions under about a day old are refused, so the lockfile has
  `bullmq 6.7.4`, `turbo 2.11.10`, `prettier 3.9.10`. `QUEUES.md` and `bullmq-101.md` now say 6.7.x.
- **Zod silently drops a `__proto__` key** while parsing, so `parseFilter` checks forbidden path
  segments on the raw input first.
- **Shell heredocs and backticks inside `node -e "..."` break in Git Bash on this machine.** Files are
  created with the editor tools; multi-line patches go through a script file.
- **`pnpm dev` and the mock-receiver container both wanted port 4000.** The receiver's watch script is
  now `start:watch`, outside `pnpm dev`; the container is the default.
- **Docs corrected:** `DATA-MODEL.md` said the Prisma config imports `dotenv/config`; it uses
  `process.loadEnvFile()`. `ARCHITECTURE.md` got the footnote for ADR-0018.

### Questions I should be able to answer

- **What exactly makes a `202` safe to send?** The Event row is committed in Postgres. Nothing after
  that point (enqueue, publish) can fail the request, and the sweeper repairs a missing job.
- **Why is the rate limit checked after the signature?** So that anyone who knows a source URL cannot
  spend the tenant's quota with forged requests. Rejected requests are not counted either.
- **Why can two concurrent duplicates not both be stored?** The unique index decides inside Postgres.
  A check in application code would have a gap between the check and the insert.
- **Why does the api's Redis connection have no offline queue?** With it, a command issued during an
  outage waits for Redis, and the webhook provider waits with it. Failing fast keeps the `202` fast;
  the rate limiter then fails open and the job is left to the sweeper.
- **What does the AAD add to the encryption?** It binds a ciphertext to its tenant and purpose. A
  database write that copies a secret into another tenant's row produces something that will not decrypt.
- **Why is `/health` separate from `/ready`?** A Redis outage must fail readiness only. If liveness
  failed too, the platform would restart an api that is still accepting webhooks correctly.

### Deviations and follow-ups

- ADR written: [ADR-0018](adr/0018-seed-script-imports-core.md), the seed script may import `@hdl/core`.
- Logging uses Fastify's built-in logger instead of `nestjs-pino` (allowed by ADR-0015; no new ADR).
- `packages/core` coverage is not enforced yet: its 90 % threshold is a Day 2 criterion.
- AC6.2 (a bad filter is rejected with `400` at connection create/update) is covered at the schema
  level in `shared`; the HTTP endpoint that returns the `400` is Day 3.
- AC16.1 is tested for sources created by the test factory and the seed. Creating a source or
  destination through the API (SEC-ENC-06) is Day 3.
- During a Redis outage an accepted event stays `RECEIVED` with no job until the Day 2 sweeper exists.
- The mock receiver has no control API yet (Day 2).

## 2026-11-13 — Worker pipeline, security, replay (Day 2)

### What was built

- **`packages/core`, the rest**: `delivery/backoff.ts` (`computeBackoffDelay`, random source injected),
  `delivery/retry-after.ts`, `delivery/classify.ts`, `ssrf/address-check.ts` (the CIDR tables),
  `ssrf/resolve-target.ts` (rules 1–4 and the allowlist), `ssrf/safe-http-client.ts` (undici with a
  pinned `lookup`), `stream/subscriber.ts`, and `enqueueDelivery` / `enqueueDeliveries`.
- **`tools/mock-receiver`, full version**: scenarios per bucket, the control API, and the query
  parameters (`status`, `delayMs`, `retryAfter`, `hang`, `redirectTo`, `bodyBytes`).
- **`apps/worker`** (plain TypeScript on BullMQ): `worker-app.ts` (connections, both Workers, the
  backoff strategy, shutdown), `fanout/fanout.processor.ts`, `delivery/delivery.processor.ts`,
  `delivery/outbound-request.ts` (the signed headers), `failed-listeners.ts`, `sweeper.ts`, `main.ts`
  (signals only).
- **`apps/api`, management part one**: `auth/api-key.guard.ts` and `GET /api/v1/whoami`;
  `events/` and `deliveries/` (lists with cursor pagination, details, attempts);
  `deliveries/replay.service.ts` (single and bulk replay); `infrastructure/lazy-queue.ts` shared by
  the fanout and delivery producers; `common/pagination.ts`, `validation.ts`, `serializers.ts`.
- **Tests**: 647 unit and 223 integration tests in total. Every `SEC-*` id (53) and every Day 2
  acceptance criterion (30) is in at least one test name.

### Concepts it relied on

- **At-least-once delivery.** The request is sent before the attempt is recorded. A crash in between
  re-runs the job and the destination gets the event twice, with the same `webhook-id`. The shutdown
  test shows exactly that duplicate. [delivery guarantees](learning/webhooks-101.md#delivery-guarantees)
- **Compare-and-set status updates.** Fan-out flips `RECEIVED → FANNED_OUT` with the old status in the
  `WHERE`; every Delivery update has `status IN (PENDING, RETRYING)`. A second run, the failed listener
  and the sweeper can all race the processor and exactly one of them writes.
  [Delivery status](DATA-MODEL.md#delivery-status)
- **Backoff with full jitter, computed by the processor.** The delay is random in `[0, ceiling)`, with
  `Retry-After` as a capped floor for `429` and `503`. The processor stores it as `nextAttemptAt` and
  hands it to BullMQ inside `RetryableDeliveryError`.
  [backoff and jitter](learning/reliability-patterns.md#backoff-and-jitter), [retries](learning/bullmq-101.md#retries)
- **Stalled jobs and the two backstops.** A job whose worker died is re-run. One that cannot finish at
  all ends in BullMQ's failed set without the processor running, so the `failed` listener and the
  sweeper mark the Delivery `DEAD`. [stalled jobs](learning/bullmq-101.md#stalled-jobs)
- **The sweeper as a reconciler.** It compares Postgres ("should be in progress") with Redis ("has a
  job") and repairs the difference. `jobId` deduplication makes it safe to run blindly.
  [outbox-lite](learning/reliability-patterns.md#outbox-lite), [job IDs](learning/bullmq-101.md#job-ids)
- **IP pinning.** The hostname is resolved once, every address is checked, and the socket's `lookup`
  answers with the checked address, so DNS cannot change its answer between check and connect.
  [IP pinning](learning/ssrf-and-network-security.md#ip-pinning)

### Gotchas found during implementation

Unverified items (the table is also in [PLAN.md](PLAN.md#results)):

- **U8.** The worker's `failed` listener fires after every failed attempt. An `UnrecoverableError`
  fires it once with `attemptsMade` still below `attempts`, so the listener checks the error type too.
- **U9.** An `add` with the `jobId` of a completed or failed job is ignored until that job is removed.
- **U10.** `new Agent({ connect: { lookup } })` works in undici 8.12, including the `all: true` form.

Found on the way:

- **Pinning the first DNS answer broke `localhost` on Windows.** `localhost` resolves to `::1` first,
  the mock receiver listens on `127.0.0.1`, so every attempt was refused and the delivery went `DEAD`.
  The same would happen to any destination with A and AAAA records from a network without IPv6. Every
  address is still checked; the first IPv4 one is pinned. [ADR-0019](adr/0019-pin-ipv4-first.md).
- **`http://2130706433/` is `127.0.0.1` for the allowlist too.** The URL parser normalises the decimal
  form before our check, so with `127.0.0.1` on the test allowlist that URL is allowed. Correct, but it
  means SSRF tests must run with an empty allowlist, as production does.
- **BullMQ 6.7 fails an over-the-limit stalled job in two steps.** The stalled check flags the job and
  returns it to the queue; the worker that takes it next fails it with
  `job stalled more than allowable limit`. Also, `worker.pause()` stops that worker's stalled check.
  `QUEUES.md` and `bullmq-101.md` were corrected.
- **`worker.close(true)` after `close()` forces nothing.** It returns the first call's promise. When the
  25 s timeout wins, shutdown disconnects the Workers' Redis connection instead, so the locks expire.
  `QUEUES.md` and `bullmq-101.md` were corrected.
- **A clean shutdown logged "Redis connection closed; reconnecting".** ioredis emits `close` for an
  intentional `quit()` as well. The connection factory now stays quiet when the status is `end`.
- **A test raced the log.** The processor logs after it has committed and published, so the row said
  `SUCCEEDED` before the log line existed. It failed once in three full runs. Tests that read logs
  wait for the line.
- **Tests share one database, so an unscoped sweep delivers other files' rows.** `sweepOnce` takes an
  optional `tenantId`. The worker never sets it; tests always do.
- **Two clicks on "replay all" would send everything twice.** Both calls read the same `DEAD` rows
  before either inserted. Bulk replay now locks the destination row (`SELECT … FOR UPDATE`) inside its
  transaction; the second call waits and then finds nothing left. A test fires three calls at once.
- **A path id that is not a UUID would reach Postgres and come back as a `500`.** The controllers
  answer `404` before the query.
- **`Buffer.from(text, 'base64url')` never throws.** It skips invalid characters, so a cursor is
  accepted only if it decodes to a UUID and encodes back to the same text.

### Questions I should be able to answer

- **Why is Postgres the attempt counter and not `job.attemptsMade`?** A stall re-runs a job without
  increasing BullMQ's counter, and a Redis wipe resets it. `Delivery.attemptCount` survives both, so
  the attempt number, the `x-hdl-attempt` header and "retries exhausted" all come from the row.
- **What happens if the worker dies right after the HTTP request?** Nothing is recorded, the lock
  expires, the job is re-run as stalled, and the destination gets a duplicate with the same
  `webhook-id`. That is what at-least-once means; the receiver deduplicates on the id.
- **How can the processor, the failed listener and the sweeper all write a final status safely?**
  Each update carries `WHERE status IN ('PENDING','RETRYING')`. The first one wins; the others match
  no row and stop. A terminal Delivery is never written again.
- **How does the system recover from a Redis outage?** Ingestion keeps answering `202` because the
  Event is in Postgres. Every 15 s the sweeper looks for Events and Deliveries that should have a job
  and do not, and adds one. Measured in the demo: three webhooks delivered 42.5 s after Redis returned.
- **Why does replay create a new Delivery instead of resetting the old one?** History stays true (the
  row that says "DEAD after 5 attempts" keeps saying it), past metrics do not change, and the new job
  id is new, so BullMQ's "this job id already exists" rule cannot swallow the replay.
- **Why is the outbound timestamp the send time and not the event time?** Receivers reject timestamps
  older than about five minutes, and a retry can come hours after the event. The `webhook-id` stays
  the same on every attempt; the timestamp and signature are new each time.

### Deviations and follow-ups

- ADR written: [ADR-0019](adr/0019-pin-ipv4-first.md), status `Proposed`. It changes which checked
  address is pinned and needs the lead's confirmation.
- Checklist items whose HTTP endpoint is Day 3 are tested one level down today, and say so in the test
  name: `SEC-SSRF-11` and AC9.1 (`validateDestinationUrl`, not the `422`), `SEC-ENC-06` (rows written
  as the seed writes them, not through `POST /api/v1/destinations`), `SEC-AUTH-04` (every `/api/v1`
  route that exists; the stream route does not exist yet), `SEC-AUTH-05` (the subscriber, not the SSE
  endpoint). Day 3 adds the endpoint-level tests.
- `SEC-LIM-04` is two tests, one per process (worker and api). One test over a full
  ingest → deliver cycle needs both processes and belongs to the Day 4 end-to-end tests.
- "`Ctrl+C` during a delivery finishes the attempt" is tested through the exported `shutdown()`
  that the signal handler calls. A real `Ctrl+C` keypress in a terminal was not automated.
- The Day 2 demo checkpoint was run against the built api and worker with the demo backoff profile:
  all six steps passed.
- Coverage: `core` 91 % lines (unit tests, threshold enforced), `worker` 97 % lines (integration).
  Thresholds for `worker` and `api` are enforced on Day 4.
- A `POST` to a replay endpoint with `Content-Type: application/json` and an empty body is answered
  `400` by Fastify's parser. Send no content type, or `{}`.
