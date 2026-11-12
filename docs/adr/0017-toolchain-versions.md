# ADR-0017: Toolchain versions and pins

- **Status**: Proposed. Day 1 proceeds on these pins unless the human lead objects.
- **Date**: 2026-11-12
- **Deciders**: docs session (proposal), human lead (confirmation)

## Context

The brief says to use current stable versions and Node.js LTS, and to verify rather than recall. The
registry was checked on 2026-11-12, and several "latest" versions turned out to be unsafe defaults.
This ADR records what was found and which versions the build pins. It is `Proposed` because two choices
deviate from "newest": TypeScript and Node.js.

Findings:

| Package | `latest` on npm | Finding |
|---|---|---|
| `typescript` | 7.0.2 | TypeScript 7 is the native compiler. Version 7.0 ships **without a compiler API** (a new one is expected in 7.1). NestJS 12's CLI and schematics declare TypeScript 6 as their peer, and `nest build` and typescript-eslint use the compiler API |
| `prisma` | **8.0.0-rc.33** | The `latest` tag points at a **release candidate** of Prisma 8, a redesign: no `schema.prisma`, no `prisma generate`, a new client package, and no `$extends` or `P2002`-style error codes yet. `@prisma/client` latest is still 7.10.1 |
| `bullmq` | 6.7.5 | v6 (2026-07-30) made `ioredis` an optional **peer** dependency, removed the legacy repeatable-jobs API and `Queue#client`, and made `Worker#resume()` async |
| `@nestjs/core` | 12.4.2 | Packages are ESM-only; a CommonJS app still works via `require(esm)`. The CLI needs Node 22.22.3+, 24.15+, or 26+. Adds `StandardSchemaValidationPipe` (Zod works without an adapter) |
| Node.js | 26.13.1 "Lithium" is Active LTS since 2026-10-28; 24.x "Krypton" is Maintenance LTS until 2028-04-30 | The lead's machine has 24.22.1. Every dependency supports both |

## Decision

| Tool | Pin | Reason |
|---|---|---|
| Node.js | **24.x** (`engines: ">=24.15 <25"`, Docker `node:24-alpine`) | An LTS line, already installed on the dev machine, explicitly supported by every dependency. 26 became Active LTS two weeks ago; moving is a one-line change after the project works |
| TypeScript | **6.x** (latest 6 minor) | Required by the NestJS 12 toolchain; TypeScript 7.0 has no compiler API yet |
| Module format | **ESM** in every workspace (`"type": "module"`) | NestJS 12 and Prisma 7 ship ESM; one format avoids interop problems |
| pnpm | 12.x, exact version in `packageManager` | Current stable |
| Turborepo | 2.x | Current stable |
| NestJS | 12.4.x with `@nestjs/platform-fastify` (Fastify 5) | Current stable |
| BullMQ | 6.7.x, plus `ioredis` 6.x installed explicitly | Current stable. BullMQ's own tests run against ioredis 6.0.0 |
| Prisma | **7.10.x**, exact: `prisma`, `@prisma/client`, `@prisma/adapter-pg` | Latest stable. **Never install `prisma` without a version** |
| Postgres | 17 (`postgres:17-alpine`) | Any supported major ≥ 14 works (`date_bin`). 17 is widely hosted. Which major Render provisions is `UNVERIFIED` (U12); match it locally if it differs |
| Redis | 8 (`redis:8-alpine`) locally and in CI; Render Key Value (Valkey 8) in production | See [ADR-0016](0016-deployment.md) |
| Zod | 4.x | Current stable; validated through NestJS's Standard Schema pipe |
| Vitest | 5.x | Current stable |
| Next.js / React | 16.x / 19.x | Current stable |
| undici | 8.x | Current stable |
| pino | 10.x | Current stable |
| ESLint | 10.x (flat config) | Current stable |
| Others | `ipaddr.js` 2.x, `autocannon` 9.x, `eventsource-parser` 4.x, `standardwebhooks` 1.x (tests only), `tsx` 4.x | Current stable |

Rules:

- Every dependency is added with an explicit major (`pnpm add bullmq@6`), and the lockfile is committed.
- The three Prisma packages are pinned to the same exact version.
- A major-version bump of any tool in this table needs a new ADR.

## Alternatives considered

| Option | Why not |
|---|---|
| TypeScript 7 everywhere | `nest build` and lint tooling would break or need the `@typescript/typescript6` shim. Type-checking with 7 while building with 6 is possible but is two compilers to keep in agreement |
| Node.js 26 | Reasonable. It became LTS on 2026-10-28; 24 is what is installed and what dependencies have been tested on longest. Low value for a four-day build |
| Prisma 8 RC | Not stable, missing features we use (error codes for the dedupe unique violation), and its documentation is still moving |
| BullMQ 5 (`release-v5.x`) | Still maintained, and most tutorials target it. v6 is current, and the breaking changes do not affect how we use it |
| CommonJS | Works with NestJS 12 through `require(esm)`, but Prisma 7 ships as ESM and expects `"type": "module"` |
| Drizzle or Kysely instead of Prisma | Would sidestep Prisma's version turbulence. Prisma was a fixed choice in the brief, and v7 is stable |

## Consequences

- Day 1 must confirm the pins install and build together before writing features. Items marked
  `UNVERIFIED` in the docs are listed in [PLAN.md](../PLAN.md#unverified-items-to-check-on-day-1).
- Most BullMQ tutorials online describe v4 or v5. Code copied from them may use removed APIs (`repeat`
  options, `queue.client`, `QueueScheduler`). Check against the v6 docs.
- Most Prisma material online describes v5 or v6 (URL in the schema, auto-loaded `.env`, `prisma-client-js`,
  auto-seeding). In v7 the URL is in `prisma.config.ts`, `.env` is loaded explicitly, a driver adapter is
  required, and `migrate dev` no longer runs `generate` or the seed.
- NestJS decorators need `experimentalDecorators` and `emitDecoratorMetadata` in `tsconfig`.
- Windows: `SIGTERM` is not delivered to Node; shutdown code must also handle `SIGINT`.

## What I should be able to explain

**Q: Why not just install the latest version of everything?**
A: "Latest" on npm was a release candidate for Prisma and a compiler without the API our framework needs
for TypeScript. Checking the registry and the release notes before pinning avoided a broken Day 1.

**Q: Why Node 24 when 26 is the active LTS?**
A: Both are LTS lines. 24 was already installed and is supported by every dependency; 26 had been LTS for
two weeks. Upgrading later is a one-line change, so the lower-risk option was to wait.

**Q: What changed in BullMQ 6 that matters here?**
A: `ioredis` is now a peer dependency we install ourselves, and the legacy repeatable-jobs API is gone in
favour of Job Schedulers. Queue, Worker, custom backoff, and `UnrecoverableError` work as before.
