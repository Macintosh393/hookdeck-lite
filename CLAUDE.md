# CLAUDE.md — working agreement for hookdeck-lite

hookdeck-lite is a self-hostable webhook gateway: it receives webhooks, verifies them, ACKs fast,
then filters, routes, delivers, retries, and replays them to subscriber endpoints.
A NestJS API ingests, a plain BullMQ worker delivers, a Next.js dashboard shows a live stream.

**`docs/` is the source of truth.** If code and docs disagree, stop and fix one of them in the same change.
Start with [docs/README.md](docs/README.md) for the map. Never invent a name that a doc already defines:
enums, queue names, env vars, endpoint paths, and header names are fixed in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#canonical-names).

## Who reads this code

The human lead knows Node.js, TypeScript, and React well. Webhooks, BullMQ, and Redis-backed queues are new
to them. They review every change and must be able to defend each decision in an interview. Write for that reader.

## Scope rules

- The build is 4 days. [docs/PLAN.md](docs/PLAN.md) says what each day delivers and what to cut first.
- Do not add features that are not in [docs/PRD.md](docs/PRD.md). If something seems missing, say so; do not build it.
- Do not swap a library or bump a major version without an ADR. Pinned versions are in
  [docs/adr/0017-toolchain-versions.md](docs/adr/0017-toolchain-versions.md). **`pnpm add prisma` without a
  version installs a Prisma 8 release candidate. Always pin `prisma@7`.**

## Commenting rules

- Comment moderately. Explain **why**, not **what**. Do not comment obvious lines.
- Every non-trivial file starts with a 2–4 line header: what the file does and where it sits in the pipeline
  (ingest → fan-out → delivery → stream).
- Tag teaching comments with `// LEARN:` wherever a concept is new for the reader, and link the doc section:

  ```ts
  // LEARN: jobId = event.id makes the enqueue idempotent. A second add with the same id is ignored,
  // so the sweeper can re-enqueue blindly. See docs/learning/bullmq-101.md#job-ids
  ```

- A `LEARN:` comment is required at least once for each of these, at the place the code first relies on it:
  raw body for HMAC, `jobId` idempotency, jitter, timing-safe compare, IP pinning, Lua atomicity,
  SSE keep-alive, BullMQ stalled jobs, at-least-once duplicates, `maxRetriesPerRequest: null`,
  AES-GCM nonce and auth tag, compare-and-set status updates.
- The lead greps `LEARN:` to study the codebase. Keep each one accurate and under 4 lines.

## The ADR rule

Write a new ADR in `docs/adr/` **in the same change** when a decision:

- affects more than one module, or
- adds a dependency, or
- changes the data model, or
- trades off reliability, security, or performance.

Use [docs/adr/0000-template.md](docs/adr/0000-template.md). Never edit an accepted ADR's decision: write a
new ADR and set the old one's status to `Superseded by NNNN`. Fixing a typo or a broken link is fine.

## The learning-log rule

At the end of each milestone (each day in the plan), append an entry to
[docs/LEARNING-LOG.md](docs/LEARNING-LOG.md): what was built, the 3–5 concepts it relied on, the gotchas found
during implementation, and the questions the lead should be able to answer about it.

## Definition of done (per task)

1. `typecheck` passes for every workspace.
2. `lint` passes with no new warnings.
3. Tests pass, and new behaviour has tests at the level [docs/TESTING.md](docs/TESTING.md) assigns to it.
4. Docs are updated: the spec doc for the area, an ADR if the ADR rule applies, OpenAPI if an endpoint changed.
5. `LEARN:` comments are in place for every new concept the change relies on.
6. Nothing is reported as done that was not run. If a check was skipped or failed, say so.

## The finish rule

**Do not stop until the task is done.** A session's task is everything its prompt lists, in order.

- Work through every numbered task and every phase ([docs/PLAN.md](docs/PLAN.md)) without pausing for
  confirmation in between. Finishing one task or one phase is not a reason to stop; start the next one.
- An ordinary obstacle (a failing test, a type error, an API that differs from the docs, a tool that
  errors) is not a reason to stop either. Diagnose it, fix it, and carry on. Record what you found.
- Done means the [definition of done](#definition-of-done-per-task) holds for every task and the report
  the prompt asks for is written. "Most of it works" is not done.
- Stop early only when: a doc is wrong in a way that changes a decision, something is impossible,
  or the next step is destructive, paid, or outward-facing (deleting data, creating paid resources,
  pushing, deploying). Then say exactly what blocks you and what you need.
- If a session must end before the task is done, it first writes a handoff prompt in `prompts/`:
  where it stopped, what is committed, what is left, and every decision the next session must keep.

## Conventions

- TypeScript strict mode, ESM everywhere (`"type": "module"`).
- No bash-only scripts in `package.json`. The lead develops on Windows with Docker Desktop. Use Node or `tsx`
  scripts and `docker compose` commands that run the same in PowerShell and in CI.
- `packages/shared` must stay browser-safe: no `node:` imports, no Node-only dependencies.
- Logs are pino JSON. Pipeline logs carry `tenantId`, `eventId`, and `deliveryId` where they apply.
  Never log secrets, API keys, signatures, or full payload bodies.
- Postgres is the source of truth. Redis holds work in progress and can be rebuilt from Postgres.

## Commands

Run everything from the repository root. All of them work the same in PowerShell and in CI.

| Command | What it does |
|---|---|
| `pnpm install` | Install every workspace. Versions come from the catalog in `pnpm-workspace.yaml` |
| `pnpm setup:env` | First time only: create `.env` from `.env.example` with a fresh `SECRETS_MASTER_KEY` |
| `docker compose up -d` | Start Postgres, Redis and the mock receiver (port 4000). `docker compose up -d postgres redis` is enough for the tests |
| `docker compose down` | Stop them. Add `-v` to also delete the Postgres data |
| `pnpm db:generate` | Generate the Prisma client into `packages/database/src/generated` (also runs before build, test and dev) |
| `pnpm db:migrate` | Apply pending migrations (`prisma migrate deploy`; never prompts) |
| `pnpm db:migrate:dev` | Create a new migration after editing `schema.prisma` (`prisma migrate dev`; interactive) |
| `pnpm db:seed` | Create the demo tenant, source, destination, connection and API key. Safe to run again |
| `pnpm db:studio` | Open Prisma Studio to look at the tables |
| `pnpm dev` | Build the packages in watch mode and run the api with reload on `http://localhost:3001` |
| `pnpm build` | Compile every workspace to `dist/` |
| `pnpm typecheck` | `tsc --noEmit` in every workspace |
| `pnpm lint` | ESLint in every workspace, including the package-boundary rules |
| `pnpm test` | Unit tests. No Postgres or Redis needed |
| `pnpm test:integration` | Integration tests against the real Postgres and Redis (uses `.env.test`: database `hookdeck_test`, Redis index 1) |
| `pnpm send-webhook` | Sign and post a sample webhook to the running api. Flags: `--same-id`, `--bad-signature`, `--source <slug>`, `--url <base>`, `--secret <whsec>` |
| `pnpm format` / `pnpm format:check` | Prettier |

One workspace only: `pnpm turbo run test --filter=@hdl/core`. One test file:
`pnpm --filter @hdl/api exec vitest run --config vitest.integration.config.ts test/ingest.int.test.ts`.

Adding a dependency: put the version in the `catalog:` of `pnpm-workspace.yaml`, refer to it as
`"catalog:"` in the workspace's `package.json`, then `pnpm install`.
