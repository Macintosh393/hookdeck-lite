# Security

hookdeck-lite accepts requests from the internet and makes requests to URLs that tenants choose. Both
directions are attack surface. This document is the security spec; the concepts behind it are explained in
[learning/webhooks-101.md](learning/webhooks-101.md) and
[learning/ssrf-and-network-security.md](learning/ssrf-and-network-security.md).

Decisions: [ADR-0008](adr/0008-signatures-and-secrets.md), [ADR-0009](adr/0009-ssrf-protection.md),
[ADR-0010](adr/0010-rate-limiting.md), [ADR-0013](adr/0013-auth-scope-cut.md).

## Threat model (STRIDE-lite)

Assets: tenants' event payloads, signing secrets, API keys, the operator's internal network, and system availability.

| # | Category | Threat | Mitigation | Residual risk |
|---|---|---|---|---|
| T1 | **S**poofing | An attacker posts forged webhooks to `/in/{sourceSlug}` | Per-source HMAC verification over the raw body | Sources in mode `none` accept anything; the slug is then the only secret. The dashboard labels such sources "unverified" |
| T2 | **S**poofing | An attacker replays a captured, validly signed webhook | Timestamp inside the signed content, ±`SIGNATURE_TOLERANCE_SECONDS`; dedupe on `(sourceId, externalEventId)` | `generic-hmac` without a timestamp header has no replay window; dedupe still applies if a dedupe header is set |
| T3 | **S**poofing | Someone impersonates hookdeck-lite to a destination | Outbound Standard Webhooks signature with a per-destination secret | The receiver must verify. We cannot enforce it |
| T4 | **S**poofing | A caller uses the management API as another tenant | API key → tenant; every query filtered by `tenantId` | A leaked API key gives full access to that tenant. No scopes |
| T5 | **T**ampering | A payload is altered between us and the destination | Outbound signature covers id, timestamp, and body | None if the receiver verifies |
| T6 | **T**ampering | A stored secret ciphertext is modified or copied to another row | AES-256-GCM auth tag; AAD binds the ciphertext to tenant and purpose | None for tampering. Master-key compromise is T9 |
| T7 | **R**epudiation | "We never received it" / "you never sent it" | Immutable Events and DeliveryAttempts with timestamps, status codes, response excerpts; replay never rewrites history | Rows can be deleted with their parent Source or Destination |
| T8 | **I**nformation disclosure | A destination URL points at an internal service (SSRF) and the response is shown in the dashboard | Scheme allowlist, IP-range blocklist after DNS resolution, IP pinning, no redirects, re-check at every delivery | Hosts in `SSRF_ALLOWLIST` are exempt by design; must be empty in production |
| T9 | **I**nformation disclosure | Database dump exposes secrets | Secrets encrypted with a master key from env; API keys stored as hashes | Whoever has both the dump and `SECRETS_MASTER_KEY` reads the secrets |
| T10 | **I**nformation disclosure | Secrets or payloads leak through logs | pino redaction; bodies never logged; job payloads carry ids only | Response-body excerpts stored in Postgres may hold whatever the destination returned |
| T11 | **I**nformation disclosure | Timing differences reveal a valid signature or key prefix | `crypto.timingSafeEqual` for every secret comparison | Negligible |
| T12 | **D**enial of service | A flood of webhooks for one tenant starves the others | Per-tenant sliding-window limit, `429` + `Retry-After` | The limiter fails open when Redis is down; unverified floods to mode-`none` sources still cost one Postgres insert each until limited |
| T13 | **D**enial of service | Huge bodies or deep filters exhaust memory or CPU | `INGEST_MAX_BODY_BYTES`; filter size, depth, and node limits; response read cap | None significant |
| T14 | **D**enial of service | A slow or hanging destination ties up workers | `DELIVERY_TIMEOUT_MS`; bounded concurrency; backoff | One tenant's many slow destinations can still fill the delivery concurrency. Circuit breaker is stretch goal C1 |
| T15 | **D**enial of service | A destination abuses `Retry-After` to park jobs | `Retry-After` capped at `BACKOFF_CAP_MS` | None |
| T16 | **E**levation of privilege | A filter rule executes code or pollutes prototypes | Declarative DSL, no `eval`; path segments `__proto__`, `constructor`, `prototype` rejected; own-property lookups only | None known |
| T17 | **E**levation of privilege | The dashboard's stored API key is stolen by XSS | React escaping; payloads rendered as text, never as HTML; key in `sessionStorage`, not `localStorage` | An XSS bug would expose the key. Accepted for this scope |

## Inbound verification

Concepts: [signatures](learning/webhooks-101.md#signatures), [raw body](learning/webhooks-101.md#raw-body),
[replay attacks](learning/webhooks-101.md#replay-attacks),
[timing-safe comparison](learning/webhooks-101.md#timing-safe-comparison).

### Getting the raw body

The signature is computed over the exact bytes the provider sent. Parsing JSON and serializing it again
changes whitespace and key order, so the HMAC would not match.

Verified against NestJS 12 docs:

```ts
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  new FastifyAdapter(),
  { rawBody: true },
);
app.useBodyParser('application/json', { bodyLimit: INGEST_MAX_BODY_BYTES });
```

```ts
@Post('in/:sourceSlug')
ingest(@Req() req: RawBodyRequest<FastifyRequest>) {
  const raw = req.rawBody;   // Buffer: the exact bytes received
}
```

- `rawBody` only works with Nest's built-in body parser enabled. Do not pass `bodyParser: false`.
- Only `application/json` is accepted on the ingestion route. Anything else is `415`.
- The raw bytes must be valid UTF-8 (`new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`),
  otherwise `400`. This guarantees `Event.body` (text) round-trips to the same bytes when we forward and
  sign it. `ignoreBOM: true` keeps a leading byte-order mark instead of silently dropping it.
- Fastify answers `415` by itself for types it has no parser for. It does have parsers for `text/plain`
  and form bodies, so the controller checks the content type as well.
- Known limitation: Fastify's JSON parser refuses a body with a `__proto__` key, or a
  `constructor.prototype` key, at any depth (`onProtoPoisoning: 'error'`, its default). Such a webhook
  gets `400 VALIDATION_ERROR`. The default is kept: it is a safe one, and no provider sends such keys.

### Modes

`Source.verificationMode` selects the algorithm. `Source.verificationConfig` holds the mode's settings and
is validated by a Zod discriminated union in `packages/shared`.

| Mode | Signed content | Signature location | Replay protection |
|---|---|---|---|
| `standard-webhooks` | `{webhook-id}.{webhook-timestamp}.{rawBody}` | `webhook-signature`: space-separated `v1,<base64>` entries | Timestamp tolerance, both directions |
| `generic-hmac` | `{timestamp}.{rawBody}` if `timestampHeader` is set, else `{rawBody}` | Configurable header, optional prefix, hex or base64 | Only if `timestampHeader` is set |
| `none` | none | none | none |

```ts
type VerificationConfig =
  | { mode: 'standard-webhooks' }
  | {
      mode: 'generic-hmac';
      signatureHeader: string;          // e.g. "x-hub-signature-256"; stored lowercased
      signaturePrefix?: string;         // e.g. "sha256="
      signatureEncoding: 'hex' | 'base64';
      timestampHeader?: string;         // e.g. "x-timestamp"; value is Unix seconds
    }
  | { mode: 'none' };
```

GitHub-style signing is `generic-hmac` with `signatureHeader: "x-hub-signature-256"`,
`signaturePrefix: "sha256="`, `signatureEncoding: "hex"`, and no timestamp header.

### Algorithm

```
1. Read the signature header(s). Missing -> 401.
2. If the mode has a timestamp:
     parse as an integer of Unix seconds (strict: digits only). Invalid -> 401.
     |now - timestamp| > SIGNATURE_TOLERANCE_SECONDS -> 401.
3. expected = HMAC-SHA256(key, signedContent)        # key: see "Secret formats"
4. For each candidate signature in the header:
     decode it; if length differs from expected, skip;
     if crypto.timingSafeEqual(candidate, expected) -> valid.
5. No candidate matched -> 401 INVALID_SIGNATURE.
```

- The check order (timestamp, then HMAC) matches the Standard Webhooks reference library.
- Compare decoded bytes, not strings. `timingSafeEqual` throws on unequal lengths, hence the length check first.
- The `401` body never says which step failed. The log line does, without the signature value.
- A source whose stored secret cannot be decrypted (tampered ciphertext, wrong master key) is a server
  fault, not a bad request: the answer is `500 INTERNAL` and nothing is stored.
- `standard-webhooks` accepts several signatures in one header (space-separated). That is how providers
  rotate keys without downtime. Entries with a version other than `v1` are ignored.
- The reference library uses `parseInt`, which accepts `"123abc"`. We are stricter.

### Deduplication

`externalEventId` is read from `Source.dedupeHeader` (lowercased). It defaults to `webhook-id` for
`standard-webhooks` sources and to null otherwise. It is truncated to 255 characters. Idempotency explained:
[idempotency](learning/webhooks-101.md#idempotency).

## Outbound signing

Every delivery attempt is signed per the Standard Webhooks spec (v1.0.0, verified 2026-11-12).

| Header | Value |
|---|---|
| `webhook-id` | `Event.id`. The same for every attempt and every replay of that event, to every destination |
| `webhook-timestamp` | Unix seconds **at the time this attempt is sent** |
| `webhook-signature` | `v1,` + base64( HMAC-SHA256( key, `{webhook-id}.{webhook-timestamp}.{body}` ) ) |
| `content-type` | The Event's original content type |
| `user-agent` | `hookdeck-lite/1.0` |
| `x-hdl-delivery-id` | `Delivery.id` |
| `x-hdl-attempt` | Attempt number, 1-based |

- `body` is `Event.body`, byte for byte.
- `webhook-timestamp` must be the attempt time, not the event time. Receivers reject timestamps older than
  their tolerance (5 minutes in the reference library), and our retries span hours.
- `webhook-id` identifies the event, not the attempt. A receiver that stores seen ids stays correct across
  retries, stalled-job duplicates, and replays. See [ADR-0005](adr/0005-at-least-once-delivery.md).
- Acceptance test: the official `standardwebhooks` npm package verifies our output.

### Secret formats

| Secret | Format | HMAC key |
|---|---|---|
| Destination signing secret | `whsec_` + base64 of 32 random bytes. Generated by us on create and on rotate | base64-decode the part after `whsec_` |
| Source secret, `standard-webhooks` | Must be `whsec_…` (24–64 bytes when decoded). Provided by the user, or generated if omitted | base64-decode the part after `whsec_` |
| Source secret, `generic-hmac` | Any non-empty string up to 256 characters | the UTF-8 bytes of the string |

The destination secret is returned once in the response to `POST /api/v1/destinations` and to
`POST /api/v1/destinations/{id}/rotate-secret`. No other endpoint returns any secret.

## Secret encryption

Concept: [encrypting secrets at rest](learning/ssrf-and-network-security.md#encrypting-secrets-at-rest).

Source and destination secrets must be readable again, because we compute HMACs with them. So they are
encrypted, not hashed.

| Property | Choice |
|---|---|
| Algorithm | AES-256-GCM (`node:crypto` `createCipheriv('aes-256-gcm', key, iv)`) |
| Key | `SECRETS_MASTER_KEY`: base64 of exactly 32 bytes. Startup fails if missing or the wrong length |
| IV (nonce) | 12 random bytes from `crypto.randomBytes`, new for every encryption |
| Auth tag | 16 bytes |
| AAD | `"{tenantId}:{purpose}"` where purpose is `source-secret` or `destination-secret` |
| Stored envelope | `v1:<keyId>:<iv b64>:<ciphertext b64>:<tag b64>`, with `keyId = "k1"` |

- The AAD (additional authenticated data) is not secret, but decryption fails unless the same AAD is
  supplied. A ciphertext copied into another tenant's row, or from a source to a destination, will not decrypt.
- Never reuse an IV with the same key. Random 96-bit IVs are safe for far more encryptions than this
  system will perform.
- Decrypted secrets live in memory only: in the API's source cache (30 s TTL) and for the duration of a delivery job.
- Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

### Key rotation (documented future step, stretch C5)

The envelope already carries a key id, so rotation needs no schema change:

1. Add `SECRETS_MASTER_KEY_PREVIOUS` (the old key, id `k1`) and set `SECRETS_MASTER_KEY` to the new key (id `k2`).
2. Decryption picks the key by the envelope's key id. Encryption always uses the current key.
3. A script re-encrypts every `secretEnc` and `signingSecretEnc`.
4. Remove the previous key from the environment.

## SSRF protection

Concepts: [what SSRF is](learning/ssrf-and-network-security.md#what-ssrf-is),
[DNS rebinding](learning/ssrf-and-network-security.md#dns-rebinding),
[IP pinning](learning/ssrf-and-network-security.md#ip-pinning).

All outbound requests go through one function in `packages/core`. Nothing else in the codebase may call
`fetch`, `undici`, or `node:http(s)` for a tenant-supplied URL.

### Rules

1. **Scheme**: `http:` or `https:` only. Parse with the WHATWG `URL` class.
2. **No credentials in the URL** (`user:pass@host`) and no fragment. Port must be 1–65535.
3. **Resolve** the hostname with `dns.lookup(host, { all: true })`. If the host is an IP literal, use it directly.
4. **Check every resolved address** against the blocklist. If any address is blocked, reject. (Rejecting
   on any, not all, stops an attacker from mixing a public and a private record.)
5. **Pin**: connect to the address that was checked. The socket's `lookup` returns that address, so there
   is no second DNS query between the check and the connection. TLS still uses the original hostname for
   SNI and certificate validation, and the `Host` header is the original host.
6. **No redirects.** A `3xx` is returned to the caller as a response and classified `PERMANENT_FAILURE`.
7. **Timeout**: `DELIVERY_TIMEOUT_MS` for the whole request (connect, headers, body), enforced with an `AbortSignal`.
8. **Response cap**: read at most `DELIVERY_MAX_RESPONSE_BYTES`, then destroy the connection.
9. **Allowlist**: a hostname listed in `SSRF_ALLOWLIST` (exact, case-insensitive match) skips rule 4 only.
   Every other rule still applies. The API and worker log a warning at startup if the list is non-empty
   while `NODE_ENV=production`.

When it runs:

| Moment | Behaviour |
|---|---|
| Destination create or update (api) | Rules 1–4. Failure → `422 DESTINATION_URL_NOT_ALLOWED`. A DNS failure here is also `422` |
| Every delivery attempt (worker) | Rules 1–9. A blocked address → `PERMANENT_FAILURE` / `SSRF_BLOCKED` |

Validating at create time is a courtesy to the user. Validating at delivery time is the actual control,
because DNS answers can change after creation.

### Implementation note

Implemented with `undici@8` (verified on Day 2, U10) in `packages/core/src/ssrf/`:

- `resolve-target.ts` applies rules 1–4 and 9 **before** any socket exists: it parses the URL, resolves
  the hostname once (or takes an IP literal as it is, because Node never calls `lookup` for a literal),
  checks every address, and returns the one address to use.
- `safe-http-client.ts` then creates one `undici` `Agent` for the request with
  `connect: { lookup }`, where `lookup` answers with that checked address and never queries DNS.
  That is the pin (rule 5). `lookup` has the signature of `dns.lookup`, including the `all: true` form.
- `undici.request()` does not follow redirects (rule 6). One `AbortSignal.timeout` covers DNS, connect,
  headers and body (rule 7). The body is read up to the cap and the Agent is destroyed (rule 8).
- The same `resolveTarget` backs `validateDestinationUrl`, the create-time check of the api.

### Blocked ranges

`ipaddr.js` parses and classifies addresses. The list below is exact and is also the test matrix.

IPv4:

| CIDR | What it is |
|---|---|
| `0.0.0.0/8` | "This network" (`0.0.0.0` reaches localhost on many systems) |
| `10.0.0.0/8` | Private |
| `100.64.0.0/10` | Carrier-grade NAT (CGNAT) |
| `127.0.0.0/8` | Loopback |
| `169.254.0.0/16` | Link-local, includes the metadata endpoint `169.254.169.254` |
| `172.16.0.0/12` | Private |
| `192.0.0.0/24` | IETF protocol assignments |
| `192.0.2.0/24` | Documentation (TEST-NET-1) |
| `192.88.99.0/24` | 6to4 relay anycast |
| `192.168.0.0/16` | Private |
| `198.18.0.0/15` | Benchmarking |
| `198.51.100.0/24` | Documentation (TEST-NET-2) |
| `203.0.113.0/24` | Documentation (TEST-NET-3) |
| `224.0.0.0/4` | Multicast |
| `240.0.0.0/4` | Reserved, includes broadcast `255.255.255.255` |

IPv6:

| CIDR | What it is |
|---|---|
| `::/128` | Unspecified |
| `::1/128` | Loopback |
| `::ffff:0:0/96` | IPv4-mapped. Extract the IPv4 address and apply the IPv4 list |
| `64:ff9b::/96` | NAT64. Extract the IPv4 address and apply the IPv4 list |
| `64:ff9b:1::/48` | Local-use NAT64 |
| `100::/64` | Discard-only |
| `2001::/32` | Teredo |
| `2001:db8::/32` | Documentation |
| `2002::/16` | 6to4. Extract the embedded IPv4 address and apply the IPv4 list |
| `fc00::/7` | Unique local (private) |
| `fe80::/10` | Link-local |
| `fec0::/10` | Site-local (deprecated) |
| `ff00::/8` | Multicast |

As a final rule, an IPv6 address outside `2000::/3` (global unicast) is blocked even if no row matches.

Encoding tricks such as `http://2130706433/`, `http://0x7f.1/`, or `http://017700000001/` are neutralised
by the WHATWG URL parser, which normalises them to `127.0.0.1` before our check. Tests assert this.

## Rate limiting

Concept: [rate limiting algorithms](learning/reliability-patterns.md#rate-limiting-algorithms).
Decision and comparison: [ADR-0010](adr/0010-rate-limiting.md).

- **Scope**: ingestion, per tenant. Limit is `Tenant.ingestRateLimit` requests per 60-second window.
- **Algorithm**: sliding-window counter. Two fixed-window counters; the previous window's count is
  weighted by how much of it still overlaps the sliding window.
- **Atomicity**: one Lua script does read, decide, and increment. Redis runs a script without interleaving
  other commands, so two concurrent requests cannot both read "one slot left". See
  [Lua scripts](learning/bullmq-101.md#lua-scripts).
- **Position in the pipeline**: after signature verification, so forged requests do not burn a tenant's quota.

```lua
-- KEYS[1] = current window key   hdl:rl:{tenantId}:{windowIndex}
-- KEYS[2] = previous window key  hdl:rl:{tenantId}:{windowIndex - 1}
-- ARGV[1] = limit   ARGV[2] = window length in ms   ARGV[3] = ms elapsed in the current window
local current  = tonumber(redis.call('GET', KEYS[1]) or '0')
local previous = tonumber(redis.call('GET', KEYS[2]) or '0')
local window   = tonumber(ARGV[2])
local elapsed  = tonumber(ARGV[3])
local weight   = (window - elapsed) / window
local estimate = previous * weight + current

if estimate >= tonumber(ARGV[1]) then
  return {0, window - elapsed}            -- rejected, ms until the current window ends
end

redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], window * 2)
return {1, 0}                             -- allowed
```

- `windowIndex = floor(nowMs / windowMs)` and `elapsed = nowMs % windowMs`, computed by the caller from one clock reading.
- Rejected requests get `429`, error code `RATE_LIMITED`, and `Retry-After: ceil(msUntilWindowEnd / 1000)`.
  That value is an upper bound on the wait, which is the safe direction.
- Rejected requests are not counted, so a client hammering a full window does not extend its own lockout.
- The script is loaded once and called by SHA (`EVALSHA`), with a fallback to `EVAL` on `NOSCRIPT`.
- **Fail open**: if the Redis call errors or times out, the request is allowed and a warning is logged.
  Dropping real webhooks because the limiter's store is down would break goal 1 of the PRD.

## API key handling

- Format: `hdl_<prefix>_<secret>`, prefix 8 and secret 32 characters from `[A-Za-z0-9]`
  (about 190 bits of entropy in the secret).
- Stored: `ApiKey.prefix` (indexed, unique) and `ApiKey.keyHash` = SHA-256 hex of the full key.
- Check: parse the prefix, load the row, compare SHA-256 of the presented key with `keyHash` using
  `timingSafeEqual`, and reject if `revokedAt` is set. `lastUsedAt` is updated at most once a minute.
- Why SHA-256 and not bcrypt or argon2: slow hashes exist to protect low-entropy passwords from guessing.
  A random 190-bit key cannot be guessed, and a slow hash on every API request would hurt latency for nothing.
- The plaintext key exists only in the seed script's output and in the user's browser `sessionStorage`.
- All `/api/v1/*` routes, including the stream, require the key. `/in/*`, `/health`, and `/ready` do not.
- Failures return `401 UNAUTHORIZED` with the same body whether the key is malformed, unknown, or revoked.

## Input limits

| Input | Limit | On violation |
|---|---|---|
| Webhook body | `INGEST_MAX_BODY_BYTES` (1 MiB) | `413 PAYLOAD_TOO_LARGE` |
| Webhook content type | `application/json` | `415 UNSUPPORTED_MEDIA_TYPE` |
| Webhook body encoding | valid UTF-8, valid JSON | `400 VALIDATION_ERROR` |
| Stored inbound headers | at most 100 headers, each value truncated to 8 KiB | truncated silently |
| External event id | 255 characters | truncated |
| Management API body | 64 KiB | `413` |
| Names | 1–100 characters | `400` |
| Destination URL | 2048 characters | `400` |
| Filter rule | 4 KiB serialized, depth 5, 50 conditions ([FILTER-RULES.md](FILTER-RULES.md#limits)) | `400` |
| List `limit` | 1–100, default 50 | `400` |
| Bulk replay | 1000 deliveries per call | response has `hasMore: true` |
| Outbound response read | `DELIVERY_MAX_RESPONSE_BYTES` (16 KiB) | truncated, flag set |
| SSE queued data per client | NestJS default (about 4 million characters), then the connection is dropped | client reconnects |

All management request bodies are validated with Zod schemas from `packages/shared`, through NestJS 12's
`StandardSchemaValidationPipe`. Unknown keys are rejected (`z.strictObject`).

CORS: only origins in `CORS_ORIGINS`. On Fastify the allowed methods must be listed explicitly
(`GET, HEAD, POST, PATCH, DELETE`), because the default omits `PATCH` and `DELETE`.

## Security test checklist

The Day 2 session turns every line into at least one automated test. IDs are referenced from
[TESTING.md](TESTING.md). U = unit, I = integration.

### Inbound verification

- [ ] SEC-IN-01 (U) Valid `standard-webhooks` signature verifies.
- [ ] SEC-IN-02 (U) One flipped bit in the body fails.
- [ ] SEC-IN-03 (U) Wrong secret fails.
- [ ] SEC-IN-04 (U) Timestamp older than tolerance fails; newer than tolerance fails; exactly at the boundary passes.
- [ ] SEC-IN-05 (U) Non-numeric timestamp, `"123abc"`, empty, and negative values fail.
- [ ] SEC-IN-06 (U) Missing any of the three headers fails.
- [ ] SEC-IN-07 (U) Header with two signatures where the second is valid passes; unknown version prefix is ignored.
- [ ] SEC-IN-08 (U) Signature of a different length does not throw and fails.
- [ ] SEC-IN-09 (U) `generic-hmac` with hex + prefix (GitHub style) verifies; base64 variant verifies.
- [ ] SEC-IN-10 (U) `generic-hmac` with a timestamp header enforces tolerance; without one it does not.
- [ ] SEC-IN-11 (I) Body `{"a":1}` signed, sent as `{ "a": 1 }` → `401` (proves the raw body is used).
- [ ] SEC-IN-12 (I) Rejected request creates no Event row and no job.
- [ ] SEC-IN-13 (I) Our verifier accepts a signature produced by the official `standardwebhooks` package.
- [ ] SEC-IN-14 (U) The comparison function used is `crypto.timingSafeEqual` (asserted by a spy).

### Outbound signing

- [ ] SEC-OUT-01 (U) The official `standardwebhooks` package verifies our signature.
- [ ] SEC-OUT-02 (I) Two attempts of one delivery carry the same `webhook-id` and different `webhook-timestamp`.
- [ ] SEC-OUT-03 (I) A replay carries the same `webhook-id` as the original.
- [ ] SEC-OUT-04 (I) The body received by the mock receiver is byte-identical to the body ingested.

### Secret encryption

- [ ] SEC-ENC-01 (U) Encrypt then decrypt returns the plaintext.
- [ ] SEC-ENC-02 (U) Two encryptions of the same plaintext differ (random IV).
- [ ] SEC-ENC-03 (U) Changing one byte of ciphertext, IV, or tag makes decryption throw.
- [ ] SEC-ENC-04 (U) Decrypting with a different AAD (other tenant, other purpose) throws.
- [ ] SEC-ENC-05 (U) A key that is not 32 bytes is rejected at startup.
- [ ] SEC-ENC-06 (I) After creating a source and a destination, no column in the database contains the plaintext secret.
- [ ] SEC-ENC-07 (I) No list or get endpoint returns a secret field.

### SSRF

- [ ] SEC-SSRF-01 (U) Every CIDR in the IPv4 and IPv6 tables: a representative address is blocked.
- [ ] SEC-SSRF-02 (U) `169.254.169.254`, `127.0.0.1`, `::1`, `fd00::1`, `::ffff:127.0.0.1`, `::ffff:10.0.0.1` are blocked.
- [ ] SEC-SSRF-03 (U) Public addresses (`93.184.216.34`, `2606:2800:220:1::1`) are allowed.
- [ ] SEC-SSRF-04 (U) `http://2130706433/`, `http://0x7f.0.0.1/`, `http://017700000001/` are blocked.
- [ ] SEC-SSRF-05 (U) `ftp:`, `file:`, `gopher:`, and `javascript:` URLs are rejected. URLs with credentials are rejected.
- [ ] SEC-SSRF-06 (U) A hostname resolving to one public and one private address is blocked (stub resolver).
- [ ] SEC-SSRF-07 (U) DNS rebinding: a stub resolver returns a public IP on the first call and a private IP on the second; the connection goes to the first IP and the resolver is called once.
- [ ] SEC-SSRF-08 (I) A `302` to `http://127.0.0.1` is not followed; the attempt is `PERMANENT_FAILURE` / `REDIRECT_NOT_FOLLOWED`.
- [ ] SEC-SSRF-09 (I) A destination that never responds is cut off at the timeout → `TIMEOUT`.
- [ ] SEC-SSRF-10 (I) A 1 MiB response is truncated to `DELIVERY_MAX_RESPONSE_BYTES` with `responseBodyTruncated = true`.
- [ ] SEC-SSRF-11 (I) `POST /api/v1/destinations` with `http://169.254.169.254/` → `422`.
- [ ] SEC-SSRF-12 (U) A host in `SSRF_ALLOWLIST` resolving to loopback is allowed; the same host with scheme `ftp:` is not.
- [ ] SEC-SSRF-13 (U) With an empty allowlist, `localhost` is blocked.

### Rate limiting

- [ ] SEC-RL-01 (I) `limit` requests pass and request `limit + 1` gets `429` with `Retry-After`.
- [ ] SEC-RL-02 (I) 50 concurrent requests against a limit of 10: exactly 10 are allowed.
- [ ] SEC-RL-03 (I) Sliding behaviour: after a full window at the limit, halfway through the next window about half the limit is available.
- [ ] SEC-RL-04 (I) Tenants are isolated: tenant A at its limit does not affect tenant B.
- [ ] SEC-RL-05 (I) Redis unavailable → request allowed (fail open) and a warning logged.
- [ ] SEC-RL-06 (I) A request with an invalid signature does not consume quota.

### API keys and tenancy

- [ ] SEC-AUTH-01 (I) No header, malformed header, unknown key, and revoked key all return the same `401` body.
- [ ] SEC-AUTH-02 (I) Tenant A's key cannot read, update, delete, or replay tenant B's resources (`404`).
- [ ] SEC-AUTH-03 (I) The database stores only the hash; the plaintext key appears in no table.
- [ ] SEC-AUTH-04 (I) `/api/v1/stream` without a key returns `401` and opens no stream.
- [ ] SEC-AUTH-05 (I) A stream for tenant A never receives tenant B's messages.

### Input limits and filters

- [ ] SEC-LIM-01 (I) Body over `INGEST_MAX_BODY_BYTES` → `413`. `text/plain` → `415`. Invalid JSON → `400`. Invalid UTF-8 → `400`.
- [ ] SEC-LIM-02 (U) Filters over the size, depth, or condition limits are rejected by the schema.
- [ ] SEC-LIM-03 (U) Paths containing `__proto__`, `constructor`, or `prototype` are rejected; evaluation never reads inherited properties.
- [ ] SEC-LIM-04 (I) Logs from a full ingest → deliver cycle contain no secret, API key, or signature value.
