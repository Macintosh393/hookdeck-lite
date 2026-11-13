# Prompt 03: Day 1 handoff (finish phase 2 and phase 3)

> Paste everything below the line into a fresh session opened at the repo root.
> It continues Day 1 from where the session of [02-day1-scaffold.md](02-day1-scaffold.md) stopped.

---

You are finishing Day 1 of hookdeck-lite. An earlier session completed Day 1 tasks 1–5 and stopped at
my request. Your job is everything that is left of Day 1: the rest of phase 2 and all of phase 3 in
docs/PLAN.md.

**Rule: do not stop until the task is done.** Work through every remaining task below, in order,
without pausing for confirmation between tasks or phases. A failing test, a type error, or a library
that behaves differently from the docs is not a reason to stop: diagnose it, fix it, record it, carry
on. Stop early only if a doc is wrong in a way that changes a decision, something is impossible, or
the next step is destructive, paid, or outward-facing (do not push, do not deploy). The full rule is
in CLAUDE.md under "The finish rule".

I am comfortable with Node, TypeScript and React; BullMQ, Redis queues and webhooks are new to me. I
review every change and must be able to explain it, so prefer readable code over clever code.

## Read first, in this order

CLAUDE.md, docs/PLAN.md (Day 1 section: phases, acceptance criteria, demo checkpoint), docs/ARCHITECTURE.md
(canonical names, sequence diagram 1), docs/SECURITY.md (inbound verification, secret encryption, rate
limiting, API key handling, input limits), docs/QUEUES.md (job payloads, job IDs, job options, Redis
connections), docs/TESTING.md, docs/api/openapi.yaml (`/in/{sourceSlug}`, `/health`, `/ready`, `ErrorResponse`),
docs/adr/0004, 0008, 0010, 0015, 0017. Then read the code that exists: `packages/shared/src`,
`packages/database`, the root config files, and both existing test guards.

## Where things stand

Branch `day-1-scaffold-ingestion` (not pushed; `main` is still at the docs commit). Working tree clean.
Commits so far, one per task (a sixth commit holds this handoff, the phases in PLAN.md and the finish rule):

| Task | State | Commit subject |
|---|---|---|
| 1 Scaffold | done | chore: scaffold the pnpm + Turborepo monorepo |
| 2 Unverified items | done (results below; not yet in the learning log) | test: resolve the Day 1 unverified toolchain items |
| 3 docker-compose, env | done, except `tools/mock-receiver/Dockerfile`, which compose references | chore: add docker-compose, env templates and a setup script |
| 4 packages/database | schema, migration, client done. **Seed not written** | feat(database): Prisma schema, first migration and pg-adapter client |
| 5 packages/shared | done: 168 tests, 100 % lines, 99 % branches | feat(shared): types, Zod schemas and the filter engine |
| 6 packages/core | **not started** (`src/index.ts` is a placeholder) | |
| 7 tools/mock-receiver | **not started** (placeholder `src/index.ts`) | |
| 8 apps/api | **not started** (placeholder `src/main.ts`, plus `src/di-metadata.test.ts`) | |
| 9 send-webhook | **not started** (`.send-webhook-last-id` is already in `.gitignore`) | |
| 10 Commands + learning log | **not started** | |

Local state on my machine: pnpm 12.18.0 is enabled through corepack. `.env` exists (made by
`pnpm setup:env`). `docker compose up -d postgres redis` is running; Redis reports `noeviction`; the
databases `hookdeck` and `hookdeck_test` exist; the `init` migration is applied to `hookdeck` only.
`pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` were green at the last commit.

## What the unverified items turned out to be

Record these in the Day 1 learning-log entry (task 10). Do not re-verify them.

| # | Result |
|---|---|
| U1 | pnpm 12 uses `allowBuilds:` (a map of package → true/false) in `pnpm-workspace.yaml`. `strictDepBuilds` defaults to true, so an unreviewed build script fails the install with `ERR_PNPM_IGNORED_BUILDS`. Allowed: `@prisma/engines`, `prisma`, `esbuild`. Denied: `msgpackr-extract` (optional native speed-up; the JS fallback is used) |
| U2 | No SWC plugin needed. Vitest 5.1 on Vite 8 emits decorator metadata from `emitDecoratorMetadata` in tsconfig; `nest new` (CLI 12.0.12) generates a plain Vitest config too. Guard: `apps/api/src/di-metadata.test.ts` |
| U3 | `nestjs-pino@5.3.1` declares `@nestjs/core ^11.0.8 \|\| ^12.0.2` and needs `pino-http ^11`. A throwaway NestJS 12.4.2 + Fastify app booted and logged with it. By default it logs **all request headers** on every line, so it needs a custom `req` serializer |
| U4 | `prisma init` (7.10.1) writes `prisma7.config.ts`. The client is generated as TypeScript into `packages/database/src/generated/prisma/` and imported from `./generated/prisma/client.js` |
| U5 | `postgres:17-alpine`, `redis:8-alpine`, `node:24-alpine` all pull |
| U6 | BullMQ 6 on ioredis 6.0.0 works against the real Redis. Guard: `packages/core/test/bullmq-ioredis.int.test.ts` |
| U7 | Latest TypeScript 6.x is 6.0.3 (pinned `~6.0.3`; typescript-eslint 8.72 supports `<6.1.0`) |

Other things found on the way, also for the learning log:

- **pnpm 12 has a release-age gate.** Versions published less than about a day ago are refused unless
  excluded. `bullmq@6.7.5`, `turbo@2.11.11` and `prettier@3.10.x` were that fresh, so the catalog
  ranges start lower and the lockfile has `bullmq 6.7.4`, `turbo 2.11.10`, `prettier 3.9.10`.
  docs/QUEUES.md says "verified against bullmq@6.7.5": correct that line to 6.7.x / 6.7.4.
- **Zod silently drops a `__proto__` key** while parsing (`z.record` and `.catchall`). A filter
  `{"body":{"__proto__":1}}` would have validated as an empty section that matches everything.
  `parseFilter` therefore checks forbidden path segments on the raw input before Zod runs.
- **BullMQ's `Queue` waits for the Redis connection to be ready** before `add()` runs. With Redis
  down, `queue.add` would hang and so would the `202`. `QueueOptions.skipWaitingForReady: true` is the
  documented fix ("useful when adding jobs via HTTP endpoints"). See the decisions below.
- **Fastify's JSON parser rejects bodies with a `__proto__` or `constructor.prototype` key** by default
  (`onProtoPoisoning: 'error'`). NOT verified through Nest's `rawBody` parser. Check it once with a
  request; if it returns `400`, leave the default, and write it down as a known limitation.
- The heredoc-heavy shell one-liners failed on this machine. Create files with the Write tool.

## Decisions already made. Keep them

1. **The seed imports `@hdl/core`.** The package table in docs/ARCHITECTURE.md says `packages/database`
   must not import `core`, but the seed must encrypt the secrets it stores, and that code is in `core`.
   Resolution: the seed lives at `packages/database/prisma/seed.ts` and imports `@hdl/core`, which is
   already a **devDependency** of `@hdl/database`. The library code in `packages/database/src` still
   must not import `core`; `eslint.config.js` enforces that and already refers to
   `docs/adr/0018-seed-script-imports-core.md`. **Write that ADR** (template: docs/adr/0000-template.md),
   add it to docs/adr/README.md, and add a footnote to the package table in ARCHITECTURE.md.
2. **Logging: use `nestjs-pino`**, as PLAN item U3 implies, on top of the pino instance from
   `core`'s logger factory. Add `nestjs-pino` and `pino-http` to the pnpm catalog and to `apps/api`.
   Serialize `req` as id, method and url only (no headers). ADR-0015 already allows either option, so
   no new ADR. If it fights you for more than a few minutes, fall back to Fastify's built-in logger
   (`new FastifyAdapter({ loggerInstance })`) and say so in the learning log.
3. **API producer queue: `skipWaitingForReady: true`**, together with the connection options the docs
   already list (`maxRetriesPerRequest: 1`, `enableOfflineQueue: false`). Add this to the "Redis
   connections" table in docs/QUEUES.md in the same commit.
4. **`pnpm setup:env`** (scripts/setup-env.ts) creates `.env` from `.env.example` with a fresh
   `SECRETS_MASTER_KEY`, so no key is committed. It is already in the demo checkpoint in PLAN.md.
5. **`pnpm db:migrate` runs `prisma migrate deploy`** (non-interactive, for the demo and tests).
   `pnpm db:migrate:dev` runs `prisma migrate dev` to create a new migration.
6. **Env loading without dotenv:** `process.loadEnvFile(path)` on the root `.env`, guarded by
   `existsSync`. It never overwrites a variable that is already set, so CI and `.env.test` win.
   `prisma7.config.ts` and both `vitest.integration.config.ts` files already do this.
7. **`.env.test` is committed** (test database, Redis index 1, a fixed test-only master key,
   `LOG_LEVEL=silent`, the integration backoff profile). The env schema must accept `silent`.
8. **Shared API types use the OpenAPI names** (`Source`, `Event`, `Delivery`, ...). They are the JSON
   shapes. Prisma's row types have the same names; alias on import where both are needed.
9. Versions live in the pnpm **catalog** in `pnpm-workspace.yaml`. Add dependencies there with an
   explicit version and refer to them as `"catalog:"`. Never `pnpm add prisma` without a version.

## What is left, in order. One commit per task

### Finish phase 2

**Task 6: `packages/core`** (Node-only; may import `@hdl/shared`, `bullmq`, `ioredis`, `pino`, `zod`; never `@hdl/database`).
Suggested files, each with a 2–4 line header:

- `src/env.ts`: Zod schema for every variable in docs/ARCHITECTURE.md#configuration with its default;
  `parseEnv(source = process.env)`; `loadDotEnvFile()`. Keep the canonical UPPER_CASE names on the
  result. `SECRETS_MASTER_KEY` must decode to exactly 32 bytes or startup fails (AC16.3, SEC-ENC-05).
- `src/logger.ts`: pino factory with redaction (`authorization`, `cookie`, `webhook-signature`,
  secrets, API keys), `pino-pretty` only in development, an optional destination stream for tests.
- `src/redis.ts`: the four connection factories of docs/QUEUES.md#redis-connections. Attach an
  `error` listener to every connection (an unhandled `error` event crashes Node) and log state changes
  once, not on every reconnect attempt. LEARN comment for `maxRetriesPerRequest: null`.
- `src/queues/types.ts`: verbatim from docs/QUEUES.md#job-payloads.
  `src/queues/factories.ts`: `createFanoutQueue`, `createDeliveryQueue`, the job options from
  QUEUES.md, `enqueueFanout` with the **LEARN comment for `jobId` idempotency**.
- `src/crypto/hmac.ts`: sign and verify for `standard-webhooks` and `generic-hmac`, exactly the
  algorithm in docs/SECURITY.md#algorithm. Use `import crypto from 'node:crypto'` and call
  `crypto.timingSafeEqual` through that default import, so SEC-IN-14 can spy on it.
  **LEARN comment for timing-safe compare** (the raw-body LEARN comment belongs in the api).
  Return a result object with a reason; the reason goes to the log, never to the HTTP response.
- `src/crypto/secret-encryption.ts`: AES-256-GCM, envelope `v1:k1:<iv>:<ciphertext>:<tag>`, AAD
  `"{tenantId}:{purpose}"`. **LEARN comment for the nonce and the auth tag.**
- `src/crypto/api-key.ts`: parse `hdl_<8>_<32>`, SHA-256 hash, timing-safe hash comparison
  (the seed needs parse and hash now; the guard comes on Day 2).
- `src/rate-limit/`: the Lua script from docs/SECURITY.md#rate-limiting as a string constant, and a
  wrapper that calls `EVALSHA`, falls back to `EVAL` on `NOSCRIPT`, takes `nowMs` as a parameter, and
  **fails open** with a warning. Keys are `hdl:rl:{tenantId}:{windowIndex}`. **LEARN comment for Lua atomicity.**
- `src/stream/publisher.ts`: `streamChannel(tenantId)` and `publishStreamMessage` (publisher only;
  the subscriber is Day 2/3).
- `src/index.ts`: exports, including `type` re-exports of `Queue`, `Redis` and `Logger`, so the api
  does not need its own `bullmq`, `ioredis` or `pino` dependency.

Tests. Put the id in the test name so a search finds it:
unit (`src/**/*.test.ts`): SEC-IN-01 to 10 and 14, SEC-OUT-01 (the official `standardwebhooks`
package verifies our signature, and we verify its), SEC-ENC-01 to 05, env parsing (AC16.3), API key
format and hash, logger redaction. Integration (`test/*.int.test.ts`, real Redis): the rate limiter
(AC4.1, AC4.2 = 50 concurrent calls against a limit of 10 allow exactly 10, sliding behaviour with an
injected clock, tenant isolation, fail open against a closed port) and the queue factories
(same `jobId` added twice is one job). Remove `--passWithNoTests` from core's scripts once tests exist.

**Seed (the rest of task 4), with ADR-0018:** `packages/database/prisma/seed.ts`, idempotent (upserts
with fixed ids). Demo tenant; API key from `SEED_API_KEY` stored as prefix + SHA-256; one
`standard-webhooks` source with `dedupeHeader: "webhook-id"` and an encrypted `whsec_` secret; one
destination at `http://localhost:${MOCK_RECEIVER_PORT}/hook/demo` with an encrypted signing secret;
one connection with no filter. Plus a load-test tenant with a very high `ingestRateLimit` and its own
source, destination and connection. Print the slug, the ingestion URL and the API key at the end.
`pnpm db:seed` already runs through Turborepo, which builds `core` first.

### Phase 3

**Task 7: `tools/mock-receiver`, minimal.** `node:http`, no dependencies. `createMockReceiver()` with
`listen(port)`, `urlFor(bucket)`, `close()`; `POST /hook/:bucket` returns `200 {"ok":true}` or the
status in `?status=`; `GET /health`; one JSON log line per request. `src/main.ts` listens on
`MOCK_RECEIVER_PORT`. Add `tools/mock-receiver/Dockerfile` (multi-stage, `node:24-alpine`, non-root,
exec-form `CMD`), then check that `docker compose up -d --build mock-receiver` starts and answers
`/health`. The control API of docs/TESTING.md is Day 2; do not build it.

**Task 8: `apps/api`.** NestJS 12 on Fastify. `nest build` / `nest start --watch` are already the scripts.

- Bootstrap in a `createApp(env)` function that both `main.ts` and the tests call: `FastifyAdapter`,
  `{ rawBody: true }`, `app.useBodyParser('application/json', { bodyLimit: INGEST_MAX_BODY_BYTES })`,
  CORS with explicit methods, `enableShutdownHooks()`, request ids (accept a sane `x-request-id` or
  generate one; return it as a header and in error bodies), listen on `0.0.0.0`.
- One exception filter that produces the `ErrorResponse` shape for our errors, Nest's `HttpException`,
  and Fastify's own errors (body too large → `413 PAYLOAD_TOO_LARGE`, wrong media type → `415`,
  invalid JSON → `400 VALIDATION_ERROR`). Check by request that parser errors really reach the
  filter; if not, set Fastify's error handler too.
- `GET /health` (no dependencies) and `GET /ready` (`SELECT 1` and `PING`, 1 s timeout each, `503`
  naming the failed check).
- `POST /in/:sourceSlug` exactly as sequence diagram 1: source cache (in memory, 30 s TTL, decrypted
  secret) → verify over the raw bytes → rate limit → insert (unique violation → `202 duplicate` with
  the first event's id) → enqueue `fanout.event` with `jobId = eventId` → publish `event.received` →
  `202 accepted`. Order of the cheap checks: `415`, invalid UTF-8 `400`, unknown or disabled source
  `404`, signature `401`, rate limit `429` + `Retry-After`. Postgres failing, at the source lookup or
  at the insert, is `503 SERVICE_UNAVAILABLE`. Redis failing never fails the request.
  Stored headers: lowercased, at most 100, values cut at 8 KiB, sensitive ones replaced by `[redacted]`.
  External event id cut at 255 characters. **LEARN comment for the raw body** where it is first used.
- Integration tests in `apps/api/test/*.int.test.ts`, driven with `app.inject()` (no port needed):
  AC1.1–AC1.6, AC2.1–AC2.5, AC3.1–AC3.3, AC4.1–AC4.4, AC15.1–AC15.2, AC16.1–AC16.2, plus SEC-IN-11
  and SEC-IN-13 where they come for free. "Redis down" (AC1.3, AC4.3, AC15.2) and "Postgres down"
  (AC1.4) are tested by creating the app with a URL that points at a closed port; do not stop the
  shared containers. AC1.3 must also assert the response is fast (well under a second).
  Each file creates its own tenant and a unique `BULLMQ_PREFIX`, and cleans up in `afterAll`.
- A Vitest global setup for the api's integration config: check that Postgres and Redis answer (else
  fail with "Postgres/Redis not reachable. Run: docker compose up -d postgres redis") and run
  `prisma migrate deploy` against `hookdeck_test` once.

**Task 9: `scripts/send-webhook.ts`** (root script `send-webhook`, run with tsx; it imports the built
`@hdl/core` and `@hdl/database`). Signs a sample `order.created` event with Standard Webhooks and posts
it. The source secret comes from `--secret`, or else is read from the database and decrypted.
Flags: `--same-id` (reuse the id stored in `.send-webhook-last-id`, so the second call is a
duplicate), `--bad-signature`, `--source <slug>`, `--url <base>`. Prints the status and the body.

**Task 10: docs.** Replace the Commands placeholder in CLAUDE.md with the real commands (setup:env,
install, dev, build, typecheck, lint, test, test:integration, db:generate, db:migrate, db:migrate:dev,
db:seed, db:studio, send-webhook, compose up/down). Append the Day 1 entry to docs/LEARNING-LOG.md in
the template's format, including every unverified-item result and gotcha above. Fix the docs that the
code now disagrees with (QUEUES.md connection table and BullMQ version, ARCHITECTURE.md package-table
footnote, DATA-MODEL.md note that says the Prisma config imports `dotenv/config`, ADR-0017's status
of the U-items if it mentions them). Set core's coverage aside: its threshold is a Day 2 criterion.

## Before you report

Run and show the output of: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`,
`pnpm test`, `pnpm test:integration` (three times in a row; a flaky test is a failing test), and the
whole demo checkpoint from docs/PLAN.md, including the "stop Redis, send again, see 202 and /ready 503"
part (start Redis again afterwards). Grep for the five required `LEARN:` comments: raw body,
timing-safe compare, `jobId` idempotency, Lua atomicity, AES-GCM nonce and tag.

## Constraints

- Windows with Docker Desktop. No bash-only scripts in package.json; no `&&` chains; use tsx/Node scripts.
- Canonical names from docs/ARCHITECTURE.md#canonical-names. Do not rename anything.
- Do not build worker processors, the management API, the API-key guard, or the dashboard.
- If a doc is wrong, fix the doc in the same commit and tell me. A new cross-cutting decision gets an ADR.
- Stay on the branch `day-1-scaffold-ingestion`. Commit one task at a time. Do not push.
- Nothing is reported as done that was not run.

## When done, report

What was built; pass or fail for each Day 1 acceptance criterion in docs/PLAN.md, with the evidence
(test name or command output); anything skipped or not verified; the unverified-item table above as
it ended up; every doc you changed and why; and the exact commands of the demo checkpoint as you ran them.
