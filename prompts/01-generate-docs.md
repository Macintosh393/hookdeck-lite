# Prompt 01: Generate the project documentation set

> Paste everything below the line into a fresh Fable 5.2 session opened at the repo root.
> This session writes **docs only**. Implementation happens in later sessions that use these docs as their spec.

---

You are the lead architect for **hookdeck-lite**, an open-source, self-hostable webhook gateway (similar to Hookdeck or Svix). It receives webhooks from providers, verifies them, acknowledges them quickly, and then filters, routes, delivers, retries, and replays them to subscriber endpoints. A React dashboard shows a live stream of events.

Your job in this session is to write the **complete documentation set** that later implementation sessions will build from. **Do not write application code, scaffolding, or config files.** Code blocks inside docs are fine (Prisma schema draft, job payload types, sequence diagrams).

## Who this is for (read carefully, it changes how you write)

- I'm the human lead. I'm comfortable with Node.js, TypeScript, and React. **Webhooks, BullMQ, and Redis-backed queues are new to me.** I won't be writing the code myself, but I will review it and I need to understand and defend every architectural decision in an interview.
- So the docs serve two purposes: (1) an unambiguous spec for the agent that writes the code, and (2) a learning resource for me. When you introduce a concept (idempotency, at-least-once delivery, jitter, DNS rebinding, raw-body HMAC), explain it in plain language once, in the learning docs, and link to that explanation from everywhere else.
- **The timeline is 4 days**, not 7. Day 1 includes this docs session. Scope has to fit, so be explicit about what's in, what's stretch, and what's cut.

## Before you write: verify, don't recall

Library APIs move. Before you put any API, config option, or version into a doc, check it against the official docs or a web search: BullMQ (custom backoff strategies, `UnrecoverableError`, job IDs, `QueueEvents`, graceful shutdown), NestJS with the Fastify adapter (getting the raw body for HMAC), Prisma, Next.js, and the Standard Webhooks spec. Use current stable versions and Node.js LTS. If you can't verify something, mark it `UNVERIFIED` in the doc.

## Fixed decisions (don't re-open these; write ADRs that explain *why*)

1. **Monorepo**: pnpm workspaces + Turborepo.
2. **Folder layout** (this replaces my original draft: the worker gets its own app, and there are new `core` and `tools` folders):
   ```
   hookdeck-lite/
   ├── apps/
   │   ├── api/            # NestJS on the Fastify adapter: ingestion, management REST API, SSE stream
   │   ├── worker/         # Plain TypeScript + BullMQ (no NestJS): fan-out and delivery processors
   │   └── web/            # Next.js dashboard (client-heavy; it calls the api)
   ├── packages/
   │   ├── shared/         # Isomorphic (browser-safe): types, Zod schemas, filter-rule engine
   │   ├── database/       # Prisma schema, migrations, seed, exported client
   │   └── core/           # Node-only: queue names and job types, Redis connection, backoff,
   │                       #   HMAC sign/verify, secret encryption, SSRF-safe HTTP client, rate limiter
   ├── tools/
   │   ├── mock-receiver/  # "Chaos" endpoint: configurable failure %, latency, status codes, Retry-After
   │   └── loadtest/       # autocannon script that measures ingestion ACK latency (p50/p95/p99)
   ├── docs/               # Everything you write in this session
   ├── prompts/            # Prompts used to drive the AI build (kept as a portfolio artifact)
   ├── docker-compose.yml
   ├── CLAUDE.md
   └── README.md
   ```
   - Why the worker has no NestJS: Nest's `@Processor` decorators hide the BullMQ mechanics I'm trying to learn. Using BullMQ directly keeps the queue code readable. It also lets the worker scale and crash independently of the API.
   - Why the filter engine lives in `shared`: the dashboard can use the exact same function to preview "would this rule match this payload?"
3. **Domain model** (Hookdeck-style): `Tenant` → `Source` (inbound endpoint with its own signing secret) → `Connection` (Source → Destination, plus optional filter rules) → `Destination` (outbound URL). An incoming `Event` fans out into one `Delivery` per matching Connection. Each Delivery has many `DeliveryAttempt`s.
4. **Ingestion durability ("outbox-lite")**: the ingestion path does verify signature → rate-limit check → dedupe → insert an `Event` row → enqueue a fan-out job with `jobId = event.id` → return `202`. A periodic sweeper re-enqueues Events stuck in `RECEIVED` longer than N seconds. That covers a Redis blip between the insert and the enqueue. The ADR has to compare this against (a) Redis-only ingestion and (b) a full transactional outbox, and state what each one costs in latency and durability.
5. **Delivery semantics**: at-least-once. Duplicates are expected and documented. Outbound requests carry a stable `webhook-id` so receivers can dedupe.
6. **Two queues**: `fanout` (Event → N Deliveries) and `delivery` (one HTTP attempt per job run). Retries use BullMQ `attempts` with a **custom backoff strategy**: exponential backoff with full jitter and a cap, plus honoring `Retry-After` on 429/503. Responses are classified as follows: 2xx is success. 408, 429, and 5xx, plus timeouts and network errors, are retryable. Every other 4xx is permanent and throws `UnrecoverableError`. Write the formula and a worked table of example delays.
7. **DLQ**: BullMQ has no built-in DLQ. When a job fails for the last time, mark the Delivery `DEAD` in Postgres (Postgres is the source of truth) and surface it in the dashboard. **Replay** creates a *new* Delivery linked to the original and never mutates history. Single replay and bulk "replay all DEAD for a destination" are both in scope.
8. **Signatures**:
   - Inbound: HMAC-SHA256 over the **raw body** plus a timestamp, a tolerance window against replay attacks, and a constant-time comparison. Each Source picks a verification mode: `standard-webhooks`, `generic-hmac` (configurable header name), or `none`.
   - Outbound: sign every delivery using the **Standard Webhooks** spec (`webhook-id`, `webhook-timestamp`, `webhook-signature`).
   - Source and destination secrets are encrypted at rest with AES-256-GCM using a master key from env, because they have to be readable again to verify and sign. Hashing isn't an option.
9. **SSRF protection** in `core`'s HTTP client: allow only http/https. Resolve DNS and reject private, loopback, link-local, CGNAT, and metadata ranges for both IPv4 and IPv6 (including `169.254.169.254`, `::1`, `fc00::/7`, IPv4-mapped IPv6). **Pin the resolved IP** for the connection to defeat DNS rebinding. Validate at destination creation *and* at every delivery. Don't follow redirects. Enforce a timeout and a maximum response-body size. Add an explicit env allowlist (for example, `SSRF_ALLOWLIST=mock-receiver`) so local dev and the demo can reach the mock receiver. Without it the demo breaks.
10. **Rate limiting**: per-tenant sliding window in Redis, done atomically in a Lua script. Return `429` with `Retry-After`. The ADR compares fixed window, sliding log, and sliding-window counter.
11. **Live stream**: the worker publishes delivery lifecycle events to Redis pub/sub on a per-tenant channel. The API subscribes and exposes **SSE** (`GET /api/v1/stream`). The ADR covers SSE vs WebSockets, and app-level pub/sub vs BullMQ `QueueEvents`.
12. **Filter rules**: a small, Zod-validated JSON DSL that matches against `body`, `headers`, and `query`. Operators: `$eq`, `$neq`, `$in`, `$nin`, `$exists`, `$gt`, `$gte`, `$lt`, `$lte`, `$contains`, `$startsWith`, `$and`, `$or`, `$not`. Nested paths use dot notation. It's a pure function with no `eval` and no JSONata. Set limits on depth and size.
13. **Auth (deliberately minimal)**: a per-tenant API key (stored hashed) sent in `Authorization: Bearer`. The seed script creates a demo tenant and key. The dashboard has a simple "enter API key" screen. The data model is multi-tenant, but there's no user, login, or org-management UI. Record this as a scope-cut ADR.
14. **Testing**: Vitest everywhere. Unit tests cover the filter engine, backoff, response classification, HMAC, the SSRF guard, and the rate limiter. Integration tests run against real Postgres and Redis (docker-compose or Testcontainers; pick one and justify it in an ADR) and use the mock receiver. One end-to-end happy path plus one failure-to-DEAD-to-replay path.
15. **Observability**: pino structured logs. Every log line in the pipeline carries `tenantId`, `eventId`, and `deliveryId` where they apply. Expose a `/health` endpoint (liveness) and a `/ready` endpoint (checks Postgres and Redis).
16. **Deploy**: Docker images for api and worker on Render (or Fly.io; pick one and justify it), with managed Postgres and Redis. Deploy web to Vercel. CI on GitHub Actions: lint, typecheck, unit tests, and integration tests with service containers.

If one of these decisions turns out to be wrong or impossible after you verify it, **don't silently change it**. Write the ADR with status `Proposed`, explain the problem, recommend an alternative, and list it under "Open questions for the human lead" in `docs/PLAN.md`.

## Documents to produce

Write all of the following. Use Mermaid for every diagram. Cross-link heavily with relative links.

### `CLAUDE.md` (repo root): the working agreement for every future implementation session
Keep it short and directive. It must include:
- A project summary in 3 lines, and a pointer to `docs/` as the source of truth.
- **Commenting rules**: comment moderately and explain *why*, not *what*. Every non-trivial file starts with a 2–4 line header saying what the file does and where it sits in the pipeline. Don't comment obvious lines. Tag teaching comments with **`// LEARN:`** wherever a concept is new for the reader (raw body for HMAC, `jobId` idempotency, jitter, timing-safe compare, IP pinning, Lua atomicity, SSE keep-alive, BullMQ stalled jobs) and link the relevant doc, for example `// LEARN: see docs/learning/bullmq-101.md#retries`. I'll grep `LEARN:` to study the codebase.
- **The ADR rule**: any decision that affects more than one module, adds a dependency, changes the data model, or trades off reliability, security, or performance gets a new ADR in `docs/adr/` *in the same change*. Supersede old ADRs; don't edit them.
- **The learning-log rule**: at the end of each milestone, append an entry to `docs/LEARNING-LOG.md` covering what was built, the 3–5 concepts it relied on, the gotchas found during implementation, and the questions I should be able to answer about it.
- Definition of done per task: typecheck, lint, tests pass, docs updated, `LEARN:` comments in place.
- The commands section can be a placeholder for now. The Day 1 scaffold session fills it in.

### `docs/PRD.md`
Problem statement, target users, goals and non-goals, and features prioritized with MoSCoW. Write a user story plus **testable acceptance criteria** for each Must. Include measurable NFRs: ingestion ACK p95 < 20 ms on a local laptop measured by `tools/loadtest` (state the measurement conditions), zero lost events when the worker crashes mid-delivery, and the full retry schedule completing in a stated time window.

### `docs/ARCHITECTURE.md`
- Container and component diagram.
- **Sequence diagrams**: (1) ingestion with fast ACK, (2) fan-out and filter evaluation, (3) delivery with retry and backoff ending in success, (4) retries exhausted → DEAD → manual replay, (5) live SSE stream from worker to browser, (6) sweeper recovering an event that was never enqueued.
- **A failure-mode table**: Redis down, Postgres down, worker crash mid-job, destination slow, destination returns 410, duplicate inbound webhook, poison payload, clock skew on signatures. For each one: what happens, what the user sees, and how the system recovers.
- Where state lives (Postgres vs Redis) and why.

### `docs/DATA-MODEL.md`
ERD, a full draft Prisma schema with indexes and unique constraints (including inbound dedupe on `(sourceId, externalEventId)`), **state-machine diagrams** for Event status and Delivery status, a retention note, and the queries the dashboard metrics will use (success rate, p50/p95 latency via `percentile_cont`).

### `docs/QUEUES.md`
Queue topology, the TypeScript type of each job payload, job ID strategy, concurrency settings, the backoff formula with its worked delay table, the response classification table, stalled-job behavior, graceful shutdown, and what happens to in-flight jobs on deploy.

### `docs/SECURITY.md`
A threat model (STRIDE-lite table) plus the detailed design for inbound verification, outbound signing, secret encryption and key rotation (rotation can be a documented future step), SSRF (with the exact CIDR list), rate limiting, API key handling, input size limits, and a **security test checklist** that the Day 2 session has to turn into tests.

### `docs/FILTER-RULES.md`
The DSL spec, grammar or Zod-shape description, evaluation semantics (missing paths, type mismatches), limits, 10+ example rules with matching and non-matching payloads (these double as test cases), and why it isn't JSONata or eval.

### `docs/api/openapi.yaml`
OpenAPI 3.1 for the ingestion endpoint (`POST /in/{sourceSlug}`), management CRUD (sources, destinations, connections), events list and detail, deliveries and attempts, replay (single and bulk), metrics, the SSE stream, `/health`, and `/ready`. Use cursor pagination and a consistent error shape. Add examples on every endpoint.

### `docs/adr/`
`0000-template.md` (context / decision / alternatives considered / consequences / status), then one ADR for each fixed decision above plus any others you identify. Aim for roughly 12–16. Every ADR has a "**What I should be able to explain**" section: 2–3 interview-style questions with short answers.

### `docs/learning/`
Written for a strong TS developer who's new to this domain. Concrete, with small code snippets and diagrams. No fluff.
- `webhooks-101.md`: what webhooks are, why providers retry, signatures and replay attacks, idempotency, at-least-once vs exactly-once, how Stripe and GitHub do it, and the Standard Webhooks spec.
- `bullmq-101.md`: Redis as a queue, Queue/Worker/Job/QueueEvents, the job lifecycle (wait → active → completed/failed/delayed), attempts and backoff, job IDs and dedupe, stalled jobs and lock renewal, concurrency, graceful shutdown, and common pitfalls (connection reuse, `maxRetriesPerRequest: null`, large payloads in Redis).
- `reliability-patterns.md`: exponential backoff with jitter (why plain exponential backoff causes a thundering herd), DLQs, the outbox pattern, circuit breakers (as background for the stretch goal), and backpressure.
- `ssrf-and-network-security.md`: SSRF with real-world incidents, DNS rebinding, why you validate at connect time and not only at input time, and the cloud metadata endpoint.
- `glossary.md`: one-line definitions, each linking to its section in the docs above.

### `docs/PLAN.md`: the 4-day build plan
- **Day 1** (after this session): monorepo scaffold, docker-compose (Postgres + Redis + mock-receiver) early, Prisma schema + migrations + seed, the `shared` filter engine with full tests, and the ingestion endpoint end to end (verify → rate limit → persist → enqueue → 202).
- **Day 2**: worker fan-out and delivery, backoff and classification, DEAD handling and replay API, outbound signing, SSRF-safe client, sweeper, and security tests from the SECURITY checklist.
- **Day 3**: dashboard. Events list with filters, event detail with an attempts timeline and request/response bodies, live SSE stream, replay buttons, DEAD-letter view, metrics charts, minimal CRUD for sources, destinations, and connections, and a filter-rule tester using the shared engine.
- **Day 4**: integration and e2e tests, load test plus recording the latency numbers in the README, Dockerfiles, GitHub Actions CI, deploy, and the final README.
- For each day: ordered tasks, acceptance criteria, a **demo checkpoint** (something I can run and see by end of day), and a **ready-to-paste kickoff prompt** for that day's Fable session that references the right docs.
- A **cut list**, ranked, of what to drop first if a day overruns. Circuit breaker per destination, payload transformations, and bulk replay are the first candidates.
- **Open questions for the human lead**: anything you couldn't decide confidently.

### `docs/TESTING.md`
Test pyramid, what gets mocked and what runs for real, how the mock receiver is driven from tests, coverage targets per package (higher for `shared` and `core`), and how integration tests get Postgres and Redis locally and in CI. Note that I develop on **Windows with Docker Desktop**, so avoid bash-only scripts in `package.json` and use cross-platform tooling.

### `docs/LEARNING-LOG.md`
The template only, with one example entry showing the expected format.

### `README.md` (skeleton)
Pitch, a feature list, an architecture diagram, quickstart placeholder, links into `docs/`, and a "How this was built" section explaining that the project was AI-orchestrated, with ADRs and prompts kept in `docs/adr/` and `prompts/`. Day 4 finalizes it.

## Quality bar

- Consistency is the top priority. Entity names, status enums, queue names, env var names, endpoint paths, and header names must match across every doc. Once you've written everything, do a **consistency pass**: grep your own output for each enum and name and fix any mismatches.
- Prefer concrete over generic. "Retry up to 8 times over ~6 hours: 30s, 1m, 2m…" beats "retry with backoff".
- Keep each doc as long as it needs to be and no longer. The spec docs should be skimmable, with tables and bullets. The learning docs can be narrative.
- No placeholders like "TBD" except where this prompt explicitly allows them (the CLAUDE.md commands section and the README quickstart).

## When you're done

Reply with: (1) the file tree you created, (2) any fixed decision you challenged and why, (3) the open questions from `PLAN.md`, and (4) the Day 1 kickoff prompt, so I can start immediately.
