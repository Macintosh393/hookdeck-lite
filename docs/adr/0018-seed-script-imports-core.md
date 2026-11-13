# ADR-0018: The seed script may import `@hdl/core`

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead (decided during the Day 1 handoff)

## Context

The package table in [ARCHITECTURE.md](../ARCHITECTURE.md#components) says `packages/database` must not
import `core`. The rule keeps the dependency graph one-way: `core` knows nothing about Prisma, `database`
knows nothing about queues or cryptography, and the apps combine the two.

The seed script lives in `packages/database` (`prisma/seed.ts`, the place Prisma's `migrations.seed`
setting points at). It creates a source and a destination, and both carry a secret that must be stored
as an AES-256-GCM envelope ([ADR-0008](0008-signatures-and-secrets.md)). It also stores the demo API key
as a prefix and a SHA-256 hash. The code that does those things is in `packages/core`.

So the seed needs `core`, and the rule forbids it.

## Decision

The **seed script** imports `@hdl/core`. The **library code** of `packages/database` (everything under
`src/`, which is what the api and the worker import) still must not.

- `@hdl/core` is a `devDependency` of `@hdl/database`, not a dependency. Nothing that is built into
  `dist/` uses it.
- `eslint.config.js` applies the "must not import core" rule to `packages/database/src/**` only.
- `pnpm db:seed` runs through Turborepo with `dependsOn: ["^build"]`, so `core` is built before the seed runs.
- `core` still never imports `database`, so there is no import cycle: the seed is a leaf, like an app.

## Alternatives considered

| Option | Why not |
|---|---|
| Copy the encryption and hashing code into the seed | Two implementations of the envelope format. The day they differ, the seeded secrets stop decrypting, and nothing would test the copy |
| Move secret encryption into `packages/database` | Encryption has nothing to do with the database, and the worker and api would then get crypto from the data package. It also drags `node:crypto` rules into a package that is otherwise schema plus client |
| Move the seed to `scripts/seed.ts` at the repo root | Clean for the import rule. But Prisma's config expects the seed command next to the schema (`migrations.seed`), `pnpm db:seed` would no longer be a `database` task, and the plan and docs name `packages/database` as its home |
| A new package `packages/seed` that depends on both | A whole workspace for one file |
| Store the seed's secrets in plaintext and encrypt on first use | The database would hold plaintext secrets, which breaks AC16.1, and every reader would need a "maybe plaintext" branch |

## Consequences

- The package table needs a footnote, and it has one. The rule a reviewer should hold in their head is
  "`database/src` does not import `core`", not "`database` does not".
- `core` must be built before the seed runs. Turborepo handles that; running `tsx prisma/seed.ts`
  by hand in a fresh clone fails with a module-not-found error until `pnpm build` has run.
- If a second script ever needs both packages, it goes in the root `scripts/` folder (as
  `scripts/send-webhook.ts` does), not in `packages/database`.

## What I should be able to explain

**Q: Why is `packages/database` not allowed to import `core` in the first place?**
A: To keep dependencies one-way and each package about one thing. If both imported each other, neither
could be built or tested alone, and "where does this logic live?" would stop having an answer.

**Q: Why is the exception safe?**
A: The seed is not part of the package's library output. Nothing imports it; it is an entry point, like
an app's `main.ts`. An entry point may combine packages. The lint rule still protects `src/`.

**Q: Why not just copy the 30 lines of AES-GCM code?**
A: Because the envelope format is a contract between whoever writes a secret and whoever reads it. One
implementation, with its tests, is the only way to be sure the seed writes what the api can read.
