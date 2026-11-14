# ADR-0019: Pin the IPv4 address of a dual-stack destination

- **Status**: Proposed
- **Date**: 2026-11-13
- **Deciders**: Day 2 session; the human lead has not confirmed it yet

## Context

[ADR-0009](0009-ssrf-protection.md) pins every delivery to one address that passed the blocklist.
It does not say **which** address when a hostname has several. The first implementation used the
first one DNS returned.

Since Node 17, `dns.lookup` returns addresses in the order the operating system gives them, and on
many systems that puts IPv6 first. Two things followed, both found on Day 2:

- On Windows `localhost` resolves to `::1`, then `127.0.0.1`. A receiver bound to `127.0.0.1` (the
  in-process mock receiver, or any local server started without a host) refused the pinned `::1`
  connection, and the delivery went `DEAD` after its retries with `NETWORK_ERROR`.
- The same happens in production to any destination that publishes A and AAAA records when the
  worker's network has no IPv6 route. A browser or `fetch` would fall back to IPv4 ("Happy
  Eyeballs"). A pinned connection has nothing to fall back to.

## Decision

After **every** resolved address has passed the blocklist, `resolveTarget` pins the first IPv4
address. If the host has no IPv4 address, it pins the first address returned.

The check is unchanged: a host with one blocked record, of either family, is still rejected.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep "first address returned" | Deliveries to healthy dual-stack hosts fail on networks without IPv6, and local development on Windows breaks for `localhost` |
| Try each checked address in turn until one connects | The correct general answer, but it needs a retry loop inside the client, a split of the timeout between addresses, and care never to send the body twice. Too much for the gain in a 4-day build |
| Ask DNS for IPv4 only (`family: 4`) | AAAA records would never be seen, so a blocked IPv6 record would no longer reject the host, and IPv6-only destinations would stop working |
| Bind the mock receiver to `::` and leave the client alone | Hides the problem in tests and keeps it in production |

## Consequences

- Dual-stack destinations are reached over IPv4. IPv6-only destinations still work.
- A destination whose IPv4 address is down but whose IPv6 address is up is not reached. This is the
  rarer failure, and the attempt is retried and visible like any other network error.
- `DeliveryAttempt.resolvedIp` shows which address was used, so the choice is visible in the dashboard.
- If this ever matters, the "try each address" alternative can replace it without changing the
  blocklist or the pinning.

## What I should be able to explain

**Q: Why does pinning make the address family matter at all?**
A: A normal HTTP client gets every address and tries the next one when a connection fails. We hand the
socket exactly one address, the one we checked, so if that one is unreachable the attempt fails.

**Q: Does preferring IPv4 weaken the SSRF check?**
A: No. All addresses are checked first and one blocked record rejects the host. The preference only
decides which of the already-approved addresses to connect to.
