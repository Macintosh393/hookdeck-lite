# Documentation map

Everything the implementation sessions build from. Spec docs are terse and normative. Learning docs explain
the concepts once; spec docs link to them instead of repeating them.

## Read in this order

1. [PRD.md](PRD.md): what we are building, for whom, and what is out of scope.
2. [ARCHITECTURE.md](ARCHITECTURE.md): components, the six sequence diagrams, failure modes,
   and the [canonical names](ARCHITECTURE.md#canonical-names) every doc and file must use.
3. [DATA-MODEL.md](DATA-MODEL.md): Prisma schema draft, state machines, metrics queries.
4. [QUEUES.md](QUEUES.md): queue topology, job payloads, backoff, classification, shutdown.
5. [SECURITY.md](SECURITY.md): threat model, signatures, encryption, SSRF, rate limiting, test checklist.
6. [FILTER-RULES.md](FILTER-RULES.md): the filter DSL and its test cases.
7. [api/openapi.yaml](api/openapi.yaml): the HTTP contract.
8. [TESTING.md](TESTING.md): what is tested where.
9. [PLAN.md](PLAN.md): the 4-day plan, kickoff prompts, cut list, open questions.

## Decisions

[adr/](adr/) holds one ADR per decision. Start with the [index](adr/README.md).

## Learning material

| Doc | Covers |
|---|---|
| [learning/webhooks-101.md](learning/webhooks-101.md) | Webhooks, retries, signatures, raw body, replay attacks, idempotency, Standard Webhooks |
| [learning/bullmq-101.md](learning/bullmq-101.md) | Redis as a queue, BullMQ classes, job lifecycle, retries, job IDs, stalled jobs, shutdown, Lua, pub/sub |
| [learning/reliability-patterns.md](learning/reliability-patterns.md) | Backoff and jitter, DLQs, the outbox pattern, circuit breakers, backpressure, rate limiting, SSE |
| [learning/ssrf-and-network-security.md](learning/ssrf-and-network-security.md) | SSRF, the metadata endpoint, DNS rebinding, IP pinning, secret encryption |
| [learning/glossary.md](learning/glossary.md) | One-line definitions with links |

[LEARNING-LOG.md](LEARNING-LOG.md) is appended to at the end of each milestone.

## Verification status

Library APIs in these docs were checked on 2026-11-12 against the npm registry, the packages' own type
definitions, and the official documentation. Anything that could not be checked is marked `UNVERIFIED`
at the place it is used, and listed in [PLAN.md](PLAN.md#unverified-items-to-check-on-day-1).
