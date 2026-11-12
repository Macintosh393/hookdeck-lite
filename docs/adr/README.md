# Architecture Decision Records

One file per decision. An accepted ADR's decision is never edited: a new ADR supersedes it.
Template: [0000-template.md](0000-template.md). The rule for when to write one is in [CLAUDE.md](../../CLAUDE.md).

| # | Decision | Status |
|---|---|---|
| [0001](0001-monorepo.md) | Monorepo with pnpm workspaces and Turborepo | Accepted |
| [0002](0002-service-split.md) | NestJS API on Fastify, plain BullMQ worker, Next.js dashboard | Accepted |
| [0003](0003-domain-model.md) | Hookdeck-style domain model and UUID v7 ids | Accepted |
| [0004](0004-ingestion-durability.md) | Ingestion durability: outbox-lite with a sweeper | Accepted |
| [0005](0005-at-least-once-delivery.md) | At-least-once delivery with a stable `webhook-id` | Accepted |
| [0006](0006-queues-backoff-classification.md) | Two queues, custom backoff with full jitter, response classification | Accepted |
| [0007](0007-dead-letter-and-replay.md) | Dead letters in Postgres and immutable replay | Accepted |
| [0008](0008-signatures-and-secrets.md) | Signature verification, Standard Webhooks signing, encrypted secrets | Accepted |
| [0009](0009-ssrf-protection.md) | SSRF protection with DNS checks and IP pinning | Accepted |
| [0010](0010-rate-limiting.md) | Per-tenant sliding-window-counter rate limiting in Lua | Accepted |
| [0011](0011-live-stream.md) | Live stream: Redis pub/sub to SSE | Accepted |
| [0012](0012-filter-rules-dsl.md) | Filter rules as a small JSON DSL in `shared` | Accepted |
| [0013](0013-auth-scope-cut.md) | Auth scope cut: per-tenant API keys only | Accepted |
| [0014](0014-testing-strategy.md) | Vitest, real Postgres and Redis via docker-compose | Accepted |
| [0015](0015-observability.md) | pino logs with correlation ids, `/health` and `/ready` | Accepted |
| [0016](0016-deployment.md) | Deploy on Render and Vercel, CI on GitHub Actions | Accepted, with an open cost question |
| [0017](0017-toolchain-versions.md) | Toolchain versions and pins | Proposed |
| [0018](0018-seed-script-imports-core.md) | The seed script may import `@hdl/core` | Accepted |

`Proposed` means the human lead has not confirmed it yet. See
[PLAN.md](../PLAN.md#open-questions-for-the-human-lead).
