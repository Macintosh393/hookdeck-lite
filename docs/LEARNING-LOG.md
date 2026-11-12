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
