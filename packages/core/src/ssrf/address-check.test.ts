// Unit tests for the SSRF blocklist. The matrix is the two CIDR tables of
// docs/SECURITY.md#blocked-ranges: every row has at least one address here.
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_IPV4_RANGES,
  BLOCKED_IPV6_RANGES,
  blockedAddressReason,
  isBlockedAddress,
} from './address-check.js';

describe('isBlockedAddress', () => {
  // [CIDR from the IPv4 table, representative addresses: first, inside, last]
  const ipv4Matrix: Array<[string, string[]]> = [
    ['0.0.0.0/8', ['0.0.0.0', '0.1.2.3', '0.255.255.255']],
    ['10.0.0.0/8', ['10.0.0.0', '10.0.0.1', '10.255.255.255']],
    ['100.64.0.0/10', ['100.64.0.0', '100.100.100.100', '100.127.255.255']],
    ['127.0.0.0/8', ['127.0.0.0', '127.0.0.1', '127.255.255.255']],
    ['169.254.0.0/16', ['169.254.0.0', '169.254.169.254', '169.254.255.255']],
    ['172.16.0.0/12', ['172.16.0.0', '172.20.10.5', '172.31.255.255']],
    ['192.0.0.0/24', ['192.0.0.0', '192.0.0.8', '192.0.0.255']],
    ['192.0.2.0/24', ['192.0.2.0', '192.0.2.1', '192.0.2.255']],
    ['192.88.99.0/24', ['192.88.99.0', '192.88.99.1', '192.88.99.255']],
    ['192.168.0.0/16', ['192.168.0.0', '192.168.1.1', '192.168.255.255']],
    ['198.18.0.0/15', ['198.18.0.0', '198.19.0.1', '198.19.255.255']],
    ['198.51.100.0/24', ['198.51.100.0', '198.51.100.7', '198.51.100.255']],
    ['203.0.113.0/24', ['203.0.113.0', '203.0.113.9', '203.0.113.255']],
    ['224.0.0.0/4', ['224.0.0.0', '224.0.0.1', '239.255.255.255']],
    ['240.0.0.0/4', ['240.0.0.0', '240.0.0.1', '255.255.255.255']],
  ];

  it.each(ipv4Matrix)('SEC-SSRF-01 blocks IPv4 %s', (cidr, addresses) => {
    for (const address of addresses) {
      expect(blockedAddressReason(address), address).toContain(cidr);
    }
  });

  it('SEC-SSRF-01 the IPv4 matrix covers every row of the blocklist', () => {
    expect(ipv4Matrix.map(([cidr]) => cidr)).toEqual(BLOCKED_IPV4_RANGES.map((r) => r.cidr));
  });

  // [CIDR from the IPv6 table, representative addresses]
  const ipv6Matrix: Array<[string, string[]]> = [
    ['::/128', ['::']],
    ['::1/128', ['::1']],
    ['64:ff9b:1::/48', ['64:ff9b:1::1', '64:ff9b:1:ffff::1']],
    ['100::/64', ['100::', '100::1', '100::ffff:ffff:ffff:ffff']],
    ['2001::/32', ['2001::1', '2001:0:1234:5678::1']],
    ['2001:db8::/32', ['2001:db8::', '2001:db8::1', '2001:db8:ffff::1']],
    ['fc00::/7', ['fc00::1', 'fd00::1', 'fdff:ffff::1']],
    ['fe80::/10', ['fe80::1', 'febf::1']],
    ['fec0::/10', ['fec0::1', 'feff::1']],
    ['ff00::/8', ['ff00::1', 'ff02::1', 'ffff::1']],
  ];

  it.each(ipv6Matrix)('SEC-SSRF-01 blocks IPv6 %s', (cidr, addresses) => {
    for (const address of addresses) {
      expect(blockedAddressReason(address), address).toContain(cidr);
    }
  });

  it('SEC-SSRF-01 the IPv6 matrix covers every row of the blocklist', () => {
    expect(ipv6Matrix.map(([cidr]) => cidr)).toEqual(BLOCKED_IPV6_RANGES.map((r) => r.cidr));
  });

  it('SEC-SSRF-01 ::ffff:0:0/96 (IPv4-mapped): the embedded IPv4 address decides', () => {
    expect(blockedAddressReason('::ffff:127.0.0.1')).toContain('IPv4-mapped 127.0.0.0/8');
    expect(blockedAddressReason('::ffff:10.0.0.1')).toContain('IPv4-mapped 10.0.0.0/8');
    expect(blockedAddressReason('::ffff:a9fe:a9fe')).toContain('169.254.0.0/16'); // hex form
    expect(isBlockedAddress('::ffff:93.184.216.34')).toBe(false);
  });

  it('SEC-SSRF-01 64:ff9b::/96 (NAT64): the embedded IPv4 address decides', () => {
    expect(blockedAddressReason('64:ff9b::7f00:1')).toContain('NAT64 127.0.0.0/8');
    expect(blockedAddressReason('64:ff9b::a9fe:a9fe')).toContain('NAT64 169.254.0.0/16');
    expect(isBlockedAddress('64:ff9b::5db8:d822')).toBe(false); // 93.184.216.34
  });

  it('SEC-SSRF-01 2002::/16 (6to4): the embedded IPv4 address decides', () => {
    expect(blockedAddressReason('2002:7f00:1::1')).toContain('6to4 127.0.0.0/8');
    expect(blockedAddressReason('2002:c0a8:101::1')).toContain('6to4 192.168.0.0/16');
    expect(isBlockedAddress('2002:5db8:d822::1')).toBe(false); // 93.184.216.34
  });

  it('SEC-SSRF-01 the final rule: IPv6 outside 2000::/3 is blocked even if no row matches', () => {
    for (const address of ['::2', '1::1', '4000::1', '8000::1', 'e000::1']) {
      expect(blockedAddressReason(address), address).toContain('2000::/3');
    }
  });

  it.each([
    '169.254.169.254',
    '127.0.0.1',
    '::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ])('SEC-SSRF-02 blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '93.184.216.34',
    '2606:2800:220:1::1',
    '1.1.1.1',
    '8.8.8.8',
    '2a00:1450:4001:81b::200e',
  ])('SEC-SSRF-03 allows the public address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
    expect(blockedAddressReason(address)).toBeNull();
  });

  it.each([
    '9.255.255.255',
    '11.0.0.0',
    '100.63.255.255',
    '100.128.0.0',
    '126.255.255.255',
    '128.0.0.0',
    '169.253.255.255',
    '169.255.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '192.0.1.0',
    '192.0.3.0',
    '192.167.255.255',
    '192.169.0.0',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
  ])('SEC-SSRF-03 allows %s, the neighbour just outside a blocked range', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it.each(['', 'localhost', 'example.com', '1.2.3.4.5', '::g', 'not an ip'])(
    'blocks "%s": a string that is not an IP address is refused, not waved through',
    (value) => {
      expect(blockedAddressReason(value)).toBe('not a valid IP address');
    },
  );
});
