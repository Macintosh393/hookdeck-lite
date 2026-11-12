# ADR-0016: Deploy on Render and Vercel, CI on GitHub Actions

- **Status**: Accepted, with an open cost question for the human lead
- **Date**: 2026-11-12
- **Deciders**: human lead (platform choice delegated to the docs session)

## Context

The demo needs a public API, an always-on worker, managed Postgres, managed Redis, and the dashboard.
The brief fixed Docker images for api and worker, Vercel for web, and GitHub Actions for CI, and asked
for a choice between Render and Fly.io. The deploy happens on Day 4 with a few hours available.

Facts checked on 2026-11-12 (Render and Fly.io documentation):

| | Render | Fly.io |
|---|---|---|
| Managed Redis-compatible store | Render Key Value (Valkey 8). `noeviction` selectable, and recommended by Render for job queues | None of its own. Upstash Redis as an extension: pay-per-request, or fixed plans from $10/month |
| Managed Postgres | Yes. Free tier: 1 GB, **expires 30 days after creation** | Managed Postgres from $38/month |
| Free tier | Free web services (spin down after 15 minutes idle, about 1 minute to wake), free Postgres (30 days), free Key Value (25 MB, no persistence). **No free background workers** | None for new organizations |
| Cheapest always-on compute | Starter instance, about $7/month (`UNVERIFIED`: from third-party sources; the pricing page was not readable) | `shared-cpu-1x` 256 MB, $2.19/month |
| Everything in one config file | Yes: `render.yaml` Blueprint with `type: web`, `type: worker`, `type: keyvalue`, and `databases:` | `fly.toml` per app; databases created separately |
| Graceful shutdown | `SIGTERM`, then `SIGKILL` after 30 s by default (`maxShutdownDelaySeconds`, up to 300) | Not re-checked for this decision |

## Decision

- **api** and **worker**: Docker images on **Render**, defined with Postgres and Key Value in one
  `render.yaml` Blueprint.
  - Key Value: `maxmemoryPolicy: noeviction`.
  - api: health check path `/health`.
  - worker: `maxShutdownDelaySeconds: 30` (the worker's own deadline is 25 s).
- **web**: Vercel, with `NEXT_PUBLIC_API_URL` pointing at the Render API.
- **CI**: GitHub Actions on every push and pull request: install → lint → typecheck → unit tests →
  integration tests with Postgres and Redis **service containers**. Deploys are triggered by Render's and
  Vercel's own Git integrations on `main`.
- **Migrations** run as the API's pre-deploy command (`prisma migrate deploy`).

Why Render over Fly.io: Postgres, a Redis-compatible store with the right eviction policy, a web
service, and a worker are all first-party and declared in one file. Fly.io's compute is cheaper, but its
managed Postgres starts at $38/month and its Redis is a third-party add-on whose per-request pricing
suits BullMQ's constant polling badly. For a one-day deploy, fewer parts wins.

## Alternatives considered

| Option | Why not |
|---|---|
| Fly.io | See the table: no first-party Redis, expensive managed Postgres, more assembly |
| Railway | Comparable to Render and a reasonable choice. Not evaluated in depth; the brief named Render and Fly.io |
| One VPS with docker-compose | Cheapest and closest to "self-hostable". Needs TLS, a reverse proxy, backups, and patching by hand |
| Kubernetes | Far beyond what three containers need |
| Run the worker inside the API process to stay on the free tier | Contradicts [ADR-0002](0002-service-split.md). A free web service also sleeps after 15 minutes, which would pause delivery and the sweeper |
| Upstash Redis (serverless) | BullMQ workers issue commands continuously, so per-request billing makes even an idle queue cost money. Fly.io's own Upstash page recommends the fixed plans for that kind of workload |

## Consequences

- **Cost.** There is no fully free configuration. The worker needs a paid instance (about $7/month).
  The free Postgres is deleted 30 days after creation (plus a 14-day grace period), and free Key Value
  loses its data on restart. See the open question below.
- **Cold starts.** If the API is on the free tier it sleeps after 15 minutes without traffic and takes
  about a minute to wake. A provider's webhook would time out during that minute. A paid instance avoids it.
- **Redis flavour.** Production runs Valkey 8; local development and CI run Redis 8. BullMQ and our Lua
  script use only commands common to both, and a post-deploy smoke test exercises the full pipeline.
- Free Key Value has no persistence. That is tolerable here because jobs are rebuildable from Postgres
  by the sweeper ([ADR-0004](0004-ingestion-durability.md)), at the cost of possible duplicate deliveries.
- A deploy sends `SIGTERM` to the old worker while the new one starts. Behaviour is specified in
  [QUEUES.md](../QUEUES.md#what-happens-to-in-flight-jobs-on-deploy).
- `SSRF_ALLOWLIST` must be empty in production. The deployed demo therefore needs a public destination:
  the mock receiver deployed as a second free web service.

## Open question for the human lead

Which budget? Options, cheapest first:

1. **About $7/month**: paid worker; free API (sleeps), free Postgres (30-day life), free Key Value. Fine
   for a demo you wake up before showing it.
2. **About $14/month**: paid worker and paid API. No cold starts on ingestion.
3. **About $30/month**: also paid Postgres and Key Value with persistence. A demo that stays up.

The plan assumes option 1 unless told otherwise. Prices are `UNVERIFIED` and must be read from Render's
pricing page on Day 4.

## What I should be able to explain

**Q: Why does the worker need its own always-on instance?**
A: It holds long-lived Redis connections, runs delayed retries, and runs the sweeper. If it sleeps,
deliveries stop and recovery does not run.

**Q: Why must Redis use `noeviction` for BullMQ?**
A: With an eviction policy, Redis deletes keys when memory is full. Those keys are jobs. `noeviction`
makes Redis refuse writes instead, which fails loudly and loses nothing.

**Q: What happens to in-flight deliveries during a deploy?**
A: The old worker gets `SIGTERM`, stops taking jobs, and has 25 seconds to finish active attempts.
Anything still running is picked up as a stalled job by the new worker, possibly producing a duplicate.
