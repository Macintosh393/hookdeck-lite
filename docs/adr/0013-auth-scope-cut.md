# ADR-0013: Auth scope cut — per-tenant API keys only

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead

## Context

The interesting problems in this project are ingestion, queues, retries, and security of the delivery
path. Building users, passwords, sessions, password reset, organizations, invitations, and roles would
take a day of a four-day budget and teach nothing about webhooks. But the data must still be isolated per
tenant, because that shapes every query and index.

## Decision

- The **data model is multi-tenant**: every row has a `tenantId` and every query is scoped by it.
- **Authentication is one API key per tenant** (more can exist), sent as `Authorization: Bearer <key>`.
- Keys have the format `hdl_<prefix>_<secret>`. The database stores the prefix and a SHA-256 hash of the
  full key. The plaintext is shown once.
- The **seed script** creates a demo tenant and a key (from `SEED_API_KEY`, or generated and printed).
- The **dashboard** has an "enter API key" screen. It validates the key with `GET /api/v1/whoami` and
  keeps it in `sessionStorage` for the tab's lifetime.
- There is **no** user table, login, signup, password, session, organization management, role, or key
  management UI. Tenants and keys are created by the seed script or directly in the database.

## Alternatives considered

| Option | Why not |
|---|---|
| Full user auth (email + password, sessions, orgs) | A day of work unrelated to the project's purpose, with its own security surface (password storage, reset flows, CSRF) |
| An auth provider (Auth0, Clerk, NextAuth) | Faster than hand-rolling, but adds an external dependency and setup, and still needs org-to-tenant mapping. Out of proportion for a demo |
| Single-tenant, no `tenantId` at all | Simplest. But retrofitting tenancy later touches every table, index, and query. Carrying `tenantId` now costs little and shows the design |
| No auth on the management API | Anyone who finds the deployed demo could read payloads and replay deliveries |
| Store keys with bcrypt or argon2 | Slow hashes defend low-entropy passwords against offline guessing. A random 190-bit key cannot be guessed, and a slow hash on every request would add tens of milliseconds |
| Store the key in an httpOnly cookie via a Next.js route | Protects the key from XSS. It needs a server-side proxy for every API call and for the SSE stream, plus CSRF protection. Worth doing in a real product; too much here |

## Consequences

- A whole class of work is removed, and the day goes to the pipeline.
- A leaked API key grants full access to that tenant. There are no scopes and no expiry; revocation is
  setting `revokedAt` in the database.
- The key is readable by JavaScript in the dashboard, so an XSS bug would expose it. Mitigations: React's
  escaping, rendering payloads as text only, and `sessionStorage` rather than `localStorage`.
- The API must send CORS headers for the dashboard's origin (`CORS_ORIGINS`).
- Adding real users later means a `User` and membership table pointing at `Tenant`. Nothing in the
  existing schema would change.

## What I should be able to explain

**Q: Is this multi-tenant?**
A: The data is: every row carries a tenant id and every query filters on it. The product surface is not:
there is no signup or user management. One API key maps to one tenant.

**Q: Why SHA-256 for API keys rather than bcrypt?**
A: The key is 32 random characters, not a human password. Brute force is infeasible regardless of hash
speed, so a fast hash is safe and keeps authentication off the latency budget.

**Q: What would you change for production?**
A: Real identities and roles, scoped and expiring keys with a management UI, and keeping credentials out
of browser JavaScript by proxying through a server-side session.
