// The SSRF blocklist: decides whether an IP address is one a tenant's URL may reach.
// Pipeline position: delivery (before every connection) and destination create/update in the api.
// The CIDR lists are copied from docs/SECURITY.md#blocked-ranges, which is also the test matrix.
// Why addresses and not hostnames: docs/learning/ssrf-and-network-security.md#why-the-obvious-defences-fail
import ipaddr from 'ipaddr.js';

type IPv4 = ipaddr.IPv4;
type IPv6 = ipaddr.IPv6;

interface BlockedRange<T> {
  cidr: string;
  label: string;
  parsed: [T, number];
}

const v4 = (cidr: string, label: string): BlockedRange<IPv4> => ({
  cidr,
  label,
  parsed: ipaddr.IPv4.parseCIDR(cidr),
});
const v6 = (cidr: string, label: string): BlockedRange<IPv6> => ({
  cidr,
  label,
  parsed: ipaddr.IPv6.parseCIDR(cidr),
});

export const BLOCKED_IPV4_RANGES: ReadonlyArray<BlockedRange<IPv4>> = [
  v4('0.0.0.0/8', '"this network"'),
  v4('10.0.0.0/8', 'private'),
  v4('100.64.0.0/10', 'carrier-grade NAT'),
  v4('127.0.0.0/8', 'loopback'),
  v4('169.254.0.0/16', 'link-local, includes the cloud metadata endpoint'),
  v4('172.16.0.0/12', 'private'),
  v4('192.0.0.0/24', 'IETF protocol assignments'),
  v4('192.0.2.0/24', 'documentation (TEST-NET-1)'),
  v4('192.88.99.0/24', '6to4 relay anycast'),
  v4('192.168.0.0/16', 'private'),
  v4('198.18.0.0/15', 'benchmarking'),
  v4('198.51.100.0/24', 'documentation (TEST-NET-2)'),
  v4('203.0.113.0/24', 'documentation (TEST-NET-3)'),
  v4('224.0.0.0/4', 'multicast'),
  v4('240.0.0.0/4', 'reserved, includes broadcast'),
];

// IPv6 ranges that carry an IPv4 address inside them. The IPv4 address is what the packet
// finally reaches, so it is extracted and checked against the IPv4 list.
const IPV4_MAPPED = ipaddr.IPv6.parseCIDR('::ffff:0:0/96');
const NAT64 = ipaddr.IPv6.parseCIDR('64:ff9b::/96');
const SIX_TO_FOUR = ipaddr.IPv6.parseCIDR('2002::/16');

export const BLOCKED_IPV6_RANGES: ReadonlyArray<BlockedRange<IPv6>> = [
  v6('::/128', 'unspecified'),
  v6('::1/128', 'loopback'),
  v6('64:ff9b:1::/48', 'local-use NAT64'),
  v6('100::/64', 'discard-only'),
  v6('2001::/32', 'Teredo'),
  v6('2001:db8::/32', 'documentation'),
  v6('fc00::/7', 'unique local (private)'),
  v6('fe80::/10', 'link-local'),
  v6('fec0::/10', 'site-local (deprecated)'),
  v6('ff00::/8', 'multicast'),
];

/** Everything routable on the public IPv6 internet is inside this range. */
const GLOBAL_UNICAST = ipaddr.IPv6.parseCIDR('2000::/3');

function blockedIPv4Reason(address: IPv4): string | null {
  const hit = BLOCKED_IPV4_RANGES.find((range) => address.match(range.parsed));
  return hit ? `${hit.cidr} (${hit.label})` : null;
}

/** The IPv4 address stored in two consecutive 16-bit groups of an IPv6 address. */
function embeddedIPv4(address: IPv6, firstGroup: number): IPv4 {
  const high = address.parts[firstGroup] ?? 0;
  const low = address.parts[firstGroup + 1] ?? 0;
  return new ipaddr.IPv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
}

function blockedIPv6Reason(address: IPv6): string | null {
  // `::ffff:127.0.0.1` is loopback wearing an IPv6 costume. Unwrap before judging.
  if (address.match(IPV4_MAPPED)) {
    const inner = blockedIPv4Reason(embeddedIPv4(address, 6));
    return inner ? `IPv4-mapped ${inner}` : null;
  }
  if (address.match(NAT64)) {
    const inner = blockedIPv4Reason(embeddedIPv4(address, 6));
    return inner ? `NAT64 ${inner}` : null;
  }
  if (address.match(SIX_TO_FOUR)) {
    const inner = blockedIPv4Reason(embeddedIPv4(address, 1));
    return inner ? `6to4 ${inner}` : null;
  }

  const hit = BLOCKED_IPV6_RANGES.find((range) => address.match(range.parsed));
  if (hit) return `${hit.cidr} (${hit.label})`;

  // The final rule: an address outside global unicast is blocked even if no row above matched.
  if (!address.match(GLOBAL_UNICAST)) return 'outside 2000::/3 (not global unicast)';
  return null;
}

/**
 * Why `address` must not be contacted, or null when it is a public address.
 * A string that is not an IP address at all is blocked: when in doubt, refuse.
 */
export function blockedAddressReason(address: string): string | null {
  let parsed: IPv4 | IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return 'not a valid IP address';
  }
  return parsed.kind() === 'ipv4'
    ? blockedIPv4Reason(parsed as IPv4)
    : blockedIPv6Reason(parsed as IPv6);
}

export function isBlockedAddress(address: string): boolean {
  return blockedAddressReason(address) !== null;
}
