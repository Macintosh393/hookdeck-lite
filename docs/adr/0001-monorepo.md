# ADR-0001: Monorepo with pnpm workspaces and Turborepo

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead

## Context

The system has three apps (api, worker, web), three shared packages (shared, database, core), and two
tools (mock-receiver, loadtest). They share types, Zod schemas, the filter engine, queue definitions, and
the Prisma client. One person and one AI agent build it in four days. A change to a shared type must be
visible to every consumer in the same commit.

## Decision

One repository. pnpm workspaces link the packages (`workspace:*` dependencies). Turborepo runs tasks
(`build`, `typecheck`, `lint`, `test`) in dependency order and caches their results.

Layout: `apps/*`, `packages/*`, `tools/*`. Package names are `@hdl/<folder>`.

## Alternatives considered

| Option | Why not |
|---|---|
| Separate repositories | A type change would need publishing a package and bumping versions in three repos. Too slow for four days and it hides breakage until integration |
| npm or Yarn workspaces | They work. pnpm is stricter: a package can only import what it declares, which catches missing dependencies before deploy. It is also faster and uses less disk |
| Nx | More features (generators, module boundaries) and more configuration to learn. Turborepo is a task runner and little else, which is all we need |
| pnpm workspaces alone, no Turborepo | Possible with `pnpm -r`. We would lose caching and the declared task graph (`typecheck` needs `^build`), which keeps CI short |

## Consequences

- One `pnpm install`, one lockfile, atomic cross-package changes.
- Dockerfiles must build from the repository root and prune to one app (`turbo prune` or a filtered pnpm deploy).
- `packages/shared` is imported by the browser. It must not import Node-only code; lint enforces this.
- pnpm blocks dependency build scripts by default. Prisma's must be allowed in `pnpm-workspace.yaml`.
  Checked on Day 1: the key is `allowBuilds`, a map of package name to `true` or `false`.

## What I should be able to explain

**Q: Why a monorepo for a project this size?**
A: The apps share types, schemas, and the filter engine. In one repo a breaking change fails typecheck in
the same commit, instead of surfacing later as a runtime mismatch between API and worker.

**Q: What does Turborepo add on top of pnpm workspaces?**
A: A task graph and a cache. It knows `api` needs `shared` built first, runs independent tasks in parallel,
and skips tasks whose inputs have not changed.

**Q: Why pnpm specifically?**
A: Strict `node_modules`: a package cannot import a dependency it did not declare. That prevents "works on
my machine" bugs caused by hoisting.
