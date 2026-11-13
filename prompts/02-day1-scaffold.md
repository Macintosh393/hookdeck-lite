# Prompt 02: Day 1 kickoff (scaffold, data, filter engine, ingestion)

Used on 2026-11-12. The session completed tasks 1–5 and stopped at the lead’s request;
[03-day1-handoff.md](03-day1-handoff.md) continues from there.

```text
You are implementing Day 1 of hookdeck-lite. The complete spec is in docs/. Read these first, in order:
CLAUDE.md, docs/README.md, docs/PLAN.md (Day 1 section and "Unverified items"), docs/ARCHITECTURE.md,
docs/DATA-MODEL.md, docs/FILTER-RULES.md, docs/SECURITY.md (inbound verification, secret encryption,
rate limiting, API key handling, input limits), docs/adr/0017-toolchain-versions.md.

Follow CLAUDE.md exactly: commenting rules with `// LEARN:` tags, the ADR rule, the definition of done.
I am comfortable with Node, TypeScript and React; BullMQ, Redis queues and webhooks are new to me. I will
review the code and must be able to explain it, so prefer readable code over clever code.

Do the Day 1 tasks from docs/PLAN.md in the listed order:
1. Scaffold the monorepo (pnpm workspaces + Turborepo) with every app, package and tool folder.
   Use the version pins in ADR-0017. Never run `pnpm add prisma` without a version: pin prisma@7.
2. Resolve every item under "Unverified items to check on Day 1" before depending on it. Check the
   installed package's types or the official docs; do not rely on memory. Tell me what you found.
3. docker-compose (postgres, redis with noeviction, mock-receiver) and .env.example.
4. packages/database: Prisma schema from DATA-MODEL.md, migration, pg adapter client, seed.
5. packages/shared: types, Zod schemas, and the filter engine with every example in FILTER-RULES.md
   as a test (matching and non-matching), plus the rejected filters.
6. packages/core: env parsing, logger, Redis connections, queue names and job types, HMAC sign/verify
   (standard-webhooks and generic-hmac), secret encryption, rate-limiter Lua script. Unit tests.
7. tools/mock-receiver, minimal version.
8. apps/api: bootstrap, /health, /ready, and POST /in/{sourceSlug} end to end as in sequence diagram 1.
9. A send-webhook helper script.
10. Fill in the Commands section of CLAUDE.md and append the Day 1 entry to docs/LEARNING-LOG.md.

Constraints:
- I develop on Windows with Docker Desktop. No bash-only scripts in package.json; use tsx/Node scripts.
- Use the canonical names in docs/ARCHITECTURE.md#canonical-names. Do not rename anything.
- Do not build worker processors, the management API, or the dashboard today.
- If a doc is wrong or something is impossible, stop and tell me; propose an ADR instead of quietly
  deviating. If you must choose something the docs do not cover, write an ADR in the same change.
- Commit in small steps with clear messages, one per numbered task.

When done, report: what was built, the result of each acceptance criterion in the Day 1 section
(pass/fail with evidence), anything skipped, what each unverified item turned out to be, and the exact
commands for the Day 1 demo checkpoint.
```
