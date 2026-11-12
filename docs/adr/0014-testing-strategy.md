# ADR-0014: Vitest, with real Postgres and Redis from docker-compose

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead

## Context

Most of this system's risk is in behaviour that mocks cannot show: a unique index rejecting a duplicate,
a Lua script running atomically, a BullMQ job being delayed, retried, and stalled, a transaction rolling
back. The lead develops on Windows with Docker Desktop. CI runs on GitHub Actions. The integration tests
need Postgres, Redis, and an HTTP endpoint that misbehaves on command.

## Decision

- **Vitest** is the only test runner, in every workspace.
- **Unit tests** cover pure logic: filter engine, backoff, response classification, HMAC, encryption,
  the SSRF address checks, `Retry-After` parsing.
- **Integration tests** run against **real Postgres and Redis**. Locally these are the same containers
  that `docker compose up` starts for development. In CI they are GitHub Actions **service containers**.
  Tests read `DATABASE_URL` and `REDIS_URL` from the environment and do not know where the services came from.
- Isolation: a separate database (`hookdeck_test`), a separate Redis database index, and a unique BullMQ
  prefix per test file.
- The **mock receiver** is started in-process on a random port by the tests and scripted through its
  control API.
- Two **end-to-end** tests run API and worker together: a happy path, and failure → `DEAD` → replay.

Details and coverage targets: [TESTING.md](../TESTING.md).

## Alternatives considered

| Option | Why not |
|---|---|
| **Testcontainers** | Each test run starts its own throwaway containers, which gives perfect isolation and needs no setup step. Costs: several seconds of startup per run (more on Docker Desktop for Windows), a helper container (Ryuk) that some Windows setups block, and a second way of getting services when CI is already specified to use service containers. docker-compose is already running during development, so reusing it is the faster inner loop |
| Mock Prisma and Redis in "integration" tests | Fast, but would not catch the failures we care about: constraint violations, script atomicity, transaction behaviour, BullMQ state transitions |
| In-memory substitutes (`pg-mem`, `ioredis-mock`) | Incomplete emulation. BullMQ depends on Lua scripts and blocking commands that mocks do not implement faithfully; `percentile_cont` and `date_bin` need real Postgres |
| Jest | NestJS 12 packages are ESM-only and Jest can load them only on Node 24.9+ with caveats. NestJS 12's own ESM starter uses Vitest. One runner for all workspaces is simpler |
| Playwright browser tests for the dashboard | Valuable, and a day by themselves. The dashboard is verified by the Day 3 demo and a manual checklist |
| A public request-bin service as the delivery target | Needs internet in tests, cannot be scripted to fail on cue, and is not reproducible |

## Consequences

- Integration tests need `docker compose up -d postgres redis` first. A missing service fails fast with a
  clear message, not with a timeout.
- Tests share one Postgres and one Redis, so they must isolate by data: unique tenants per test, a unique
  BullMQ prefix per file, and cleanup in `afterAll`.
- CI and local runs use the same test code and differ only in environment variables.
- NestJS relies on `emitDecoratorMetadata`, which Vitest's default transform does not emit. The API's
  Vitest config needs the SWC plugin, or explicit `@Inject()` tokens. `UNVERIFIED` for Vitest 5 with
  NestJS 12; Day 1 settles it by checking what `nest new` generates for an ESM project.
- No browser automation: dashboard regressions are caught by hand.

## What I should be able to explain

**Q: Why real Postgres and Redis instead of mocks?**
A: The behaviours that matter here are properties of those systems: unique constraints for dedupe, Lua
atomicity for rate limiting, BullMQ's delayed and stalled handling. A mock would only test my assumptions
about them.

**Q: Why docker-compose and not Testcontainers?**
A: The services are already running for development, CI uses service containers, and the tests take
connection strings from the environment. That avoids per-run container startup on Windows and a second
provisioning mechanism. The trade-off is that tests must isolate their own data.

**Q: How do you test retries without waiting hours?**
A: The backoff base and cap are configuration. Tests set them to milliseconds, and the mock receiver is
scripted to fail a fixed number of times and then succeed.
