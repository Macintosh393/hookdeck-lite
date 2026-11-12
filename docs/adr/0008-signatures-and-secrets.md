# ADR-0008: Signature verification, Standard Webhooks signing, encrypted secrets

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead

## Context

The ingestion URL is public. Anyone who learns it can post to it, so we need proof that a request came
from the provider and was not altered or replayed. Our destinations have the same problem with us. Both
directions need shared secrets, and we need the secret values again on every request to compute an HMAC.

Background: [signatures](../learning/webhooks-101.md#signatures),
[raw body](../learning/webhooks-101.md#raw-body),
[Standard Webhooks](../learning/webhooks-101.md#standard-webhooks),
[encrypting secrets at rest](../learning/ssrf-and-network-security.md#encrypting-secrets-at-rest).

## Decision

**Inbound.** Each Source has a verification mode:

- `standard-webhooks`: HMAC-SHA256 over `{id}.{timestamp}.{rawBody}`, `webhook-*` headers, ± tolerance.
- `generic-hmac`: HMAC-SHA256 over the raw body, read from a configurable header with an optional prefix
  and hex or base64 encoding. If a timestamp header is configured, the signed content is
  `{timestamp}.{rawBody}` and the tolerance applies.
- `none`: no verification.

All modes hash the **raw request bytes** and compare with `crypto.timingSafeEqual`. Tolerance is
`SIGNATURE_TOLERANCE_SECONDS` (300), in both directions.

**Outbound.** Every attempt is signed per the Standard Webhooks spec with the destination's `whsec_` secret.

**Secrets at rest.** Source and destination secrets are encrypted with AES-256-GCM under
`SECRETS_MASTER_KEY`, with a random 12-byte IV per encryption and AAD binding the ciphertext to its
tenant and purpose. The stored envelope includes a key id for future rotation.

Detailed design: [SECURITY.md](../SECURITY.md).

One clarification of the original brief: it asked for a timestamp in every HMAC mode. Providers that sign
GitHub-style send no timestamp, so in `generic-hmac` the timestamp is optional and its absence is
documented as weaker replay protection.

## Alternatives considered

| Option | Why not |
|---|---|
| Verify against the parsed-and-reserialized JSON | Serialization changes whitespace, key order, and number formatting. The HMAC would not match. The raw bytes are the only thing both sides agree on |
| Compare signatures with `===` | String comparison stops at the first differing byte, so response time leaks how many leading bytes were right. Over many requests an attacker can recover a valid signature |
| No timestamp or tolerance | A captured request stays valid forever and can be replayed at will |
| Provider presets (Stripe, Shopify, Slack) | Each has its own header format. Useful, and a natural next step, but each preset is code and tests we do not have time for |
| Asymmetric signatures (Standard Webhooks `v1a`, ed25519) | Receivers would not need a shared secret. More key management, and the reference JavaScript library verifies only `v1`. Symmetric HMAC is the common case |
| A custom outbound scheme (`x-hdl-signature`) | Receivers would have to write verification code. With Standard Webhooks they can use an existing library in most languages |
| Hash the secrets (bcrypt, SHA-256) | A hash cannot be reversed, and HMAC needs the actual key. Hashing fits API keys, which we only compare |
| Store secrets in plaintext | A database dump, backup, or SQL injection would expose every tenant's signing keys |
| A cloud KMS or Vault | The right answer at scale: keys never leave the KMS and access is audited. It adds a cloud dependency and latency, and breaks "self-hostable with docker compose" |
| AES-CBC | Provides no integrity. A modified ciphertext decrypts to garbage without an error. GCM authenticates |

## Consequences

- The API must capture the raw body (`rawBody: true` on NestFactory) and accept only `application/json`.
- Whoever holds both the database and `SECRETS_MASTER_KEY` can read all secrets. The key is a
  deployment secret and must not be committed.
- Losing the master key makes every stored secret unusable. Sources and destinations would need new secrets.
- Decryption happens on every delivery and on source-cache misses. It is microseconds.
- `generic-hmac` without a timestamp header offers no replay window; dedupe on the provider's event id is
  the remaining protection.
- Receivers can verify with the official `standardwebhooks` libraries; our tests do exactly that.

## What I should be able to explain

**Q: Why must you verify the HMAC over the raw body?**
A: The signature covers exact bytes. Once JSON is parsed and re-serialized, whitespace and key order can
differ, and the HMAC of different bytes is different.

**Q: Why are API keys hashed but webhook secrets encrypted?**
A: We only ever compare API keys, so a one-way hash is enough. We must use webhook secrets as HMAC keys,
so we need the original value back, which requires reversible encryption.

**Q: What does the timestamp tolerance protect against?**
A: Replay. Without it, a captured signed request is valid forever. With it, a replay must happen within
five minutes, and deduplication on the event id covers that window.
