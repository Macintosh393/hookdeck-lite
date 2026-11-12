# ADR-0009: SSRF protection with DNS checks and IP pinning

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead

## Context

Tenants give us URLs and our worker sends HTTP requests to them from inside our network. We also store
part of the response and show it in the dashboard. Without controls, a tenant could set a destination to
`http://169.254.169.254/…` or `http://localhost:6379/` and use the gateway to read cloud credentials or
reach internal services. This is server-side request forgery, and a webhook sender is the textbook case.

Background: [learning/ssrf-and-network-security.md](../learning/ssrf-and-network-security.md).

## Decision

All tenant-directed requests go through one SSRF-safe client in `packages/core`:

1. Allow only `http` and `https`; reject credentials in the URL.
2. Resolve the hostname and check **every** resulting address against an explicit blocklist covering
   private, loopback, link-local (including the metadata address), CGNAT, reserved, and multicast ranges
   for IPv4 and IPv6, including IPv4-mapped, NAT64, and 6to4 forms.
3. **Pin** the connection to the checked address, so no second DNS lookup can return something else.
4. Never follow redirects.
5. Enforce a total timeout and a response-size cap.
6. Run the checks when a destination is created or updated **and** on every delivery attempt.
7. `SSRF_ALLOWLIST` lists hostnames that skip the range check, for local development and the demo
   (`mock-receiver`, `localhost`). It is empty in production.

Exact CIDR list and rules: [SECURITY.md](../SECURITY.md#ssrf-protection).

## Alternatives considered

| Option | Why not |
|---|---|
| Validate the URL only when the destination is saved | DNS can change afterwards. An attacker saves a hostname that resolves to a public IP, then repoints it to `127.0.0.1` |
| Resolve, check, then let the HTTP client resolve again | A time-of-check to time-of-use gap. With a short TTL the second lookup can return a private address (DNS rebinding) |
| Blocklist hostnames (`localhost`, `metadata.google.internal`) | Any domain can point at any IP. Only the resolved address matters |
| Regex or string checks on the IP | Misses decimal, octal, and hex encodings, IPv4-mapped IPv6, and the like. Parse to an address and test CIDR membership |
| An egress proxy such as Smokescreen, or network-level egress rules | Recommended by the Standard Webhooks spec and the strongest control, because it holds even if application code has a bug. It needs infrastructure we cannot assume on a PaaS or in docker-compose. Recommended as an additional layer for a real deployment |
| Follow redirects and validate each hop | Possible, but each hop is another chance to get it wrong, and a webhook endpoint has no good reason to redirect. The Standard Webhooks spec also says not to follow |
| No allowlist; run the mock receiver on a public address | The demo and tests would need internet access and a public endpoint. An explicit, env-controlled allowlist is simpler and visible in config review |

## Consequences

- The delivery worker cannot be used to reach internal addresses, even through DNS tricks or redirects.
- Tenants cannot deliver to genuinely private endpoints (for example, a service on the same private
  network). Self-hosters who want that must list the hostname in `SSRF_ALLOWLIST`, knowingly.
- The allowlist is a foot-gun if set in production. Startup logs a warning when it is non-empty and
  `NODE_ENV=production`.
- Destination creation performs a DNS lookup, so it can fail for reasons outside our control (`422`).
- A destination with both A and AAAA records is rejected if either resolves to a blocked range.
- This is application-level defence. A real deployment should add network egress controls as well.

## What I should be able to explain

**Q: What is DNS rebinding and how does IP pinning stop it?**
A: The attacker's DNS answers with a public IP when we validate and a private IP when we connect. Pinning
means we connect to the exact IP we validated and never ask DNS a second time.

**Q: Why check at delivery time if you already checked at creation?**
A: The DNS answer at creation says nothing about the answer an hour later. The check that protects us is
the one made for the connection we are about to open.

**Q: Why not follow redirects?**
A: A public URL can redirect to `http://169.254.169.254/`. Refusing redirects removes that path entirely.
