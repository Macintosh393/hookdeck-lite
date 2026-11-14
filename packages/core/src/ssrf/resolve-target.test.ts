// Unit tests for the URL rules and the resolve-and-check step (docs/SECURITY.md#rules, 1–4 and 9).
// DNS is a stub resolver, so nothing here touches the network.
import { describe, expect, it } from 'vitest';
import {
  parseTargetUrl,
  resolveTarget,
  SsrfBlockedError,
  systemResolver,
  validateDestinationUrl,
} from './resolve-target.js';
import type { ResolvedAddress, Resolver } from './resolve-target.js';

const PUBLIC_V4: ResolvedAddress = { address: '93.184.216.34', family: 4 };
const PUBLIC_V6: ResolvedAddress = { address: '2606:2800:220:1::1', family: 6 };
const PRIVATE_V4: ResolvedAddress = { address: '10.0.0.5', family: 4 };
const LOOPBACK_V4: ResolvedAddress = { address: '127.0.0.1', family: 4 };

/** A resolver that answers from a list, one answer per call, and counts its calls. */
function stubResolver(...answers: ResolvedAddress[][]): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const resolver = (hostname: string): Promise<ResolvedAddress[]> => {
    calls.push(hostname);
    const answer = answers[Math.min(calls.length, answers.length) - 1] ?? [];
    return Promise.resolve(answer);
  };
  return Object.assign(resolver, { calls });
}

const noDns: Resolver = () => Promise.reject(new Error('DNS must not be used in this test'));

describe('parseTargetUrl', () => {
  it('accepts http and https URLs', () => {
    expect(parseTargetUrl('http://example.com/hook').hostname).toBe('example.com');
    expect(parseTargetUrl('https://example.com:8443/hook?x=1').port).toBe('8443');
  });

  it.each([
    'ftp://example.com/',
    'file:///etc/passwd',
    'gopher://example.com/',
    'javascript:alert(1)',
  ])('SEC-SSRF-05 rejects the scheme of %s', (url) => {
    expect(() => parseTargetUrl(url)).toThrow(SsrfBlockedError);
  });

  it.each([
    'http://user:pass@example.com/',
    'https://user@example.com/',
    'http://:pw@example.com/',
  ])('SEC-SSRF-05 rejects credentials in %s', (url) => {
    expect(() => parseTargetUrl(url)).toThrow(/credentials/);
  });

  it('rejects a fragment, port 0, and a string that is not a URL', () => {
    expect(() => parseTargetUrl('http://example.com/hook#top')).toThrow(/fragment/);
    expect(() => parseTargetUrl('http://example.com:0/')).toThrow(/port/);
    expect(() => parseTargetUrl('http://example.com:70000/')).toThrow(SsrfBlockedError);
    expect(() => parseTargetUrl('not a url')).toThrow(SsrfBlockedError);
    expect(() => parseTargetUrl('')).toThrow(SsrfBlockedError);
  });
});

describe('resolveTarget', () => {
  it('returns the first resolved address of a public hostname', async () => {
    const resolver = stubResolver([PUBLIC_V4, PUBLIC_V6]);

    const target = await resolveTarget('https://example.com/hook', { allowlist: [], resolver });

    expect(target).toMatchObject({
      hostname: 'example.com',
      address: '93.184.216.34',
      family: 4,
      allowlisted: false,
    });
    expect(resolver.calls).toEqual(['example.com']);
  });

  it('SEC-SSRF-03 allows public IP literals without asking DNS', async () => {
    const v4 = await resolveTarget('http://93.184.216.34/', { allowlist: [], resolver: noDns });
    expect(v4).toMatchObject({ address: '93.184.216.34', family: 4 });

    const v6 = await resolveTarget('http://[2606:2800:220:1::1]/', {
      allowlist: [],
      resolver: noDns,
    });
    expect(v6).toMatchObject({ hostname: '2606:2800:220:1::1', family: 6 });
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:6379/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.1]/',
  ])('SEC-SSRF-02 blocks the IP literal in %s', async (url) => {
    await expect(resolveTarget(url, { allowlist: [], resolver: noDns })).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it.each(['http://2130706433/', 'http://0x7f.0.0.1/', 'http://017700000001/', 'http://0x7f.1/'])(
    'SEC-SSRF-04 blocks %s: the URL parser normalises it to 127.0.0.1',
    async (url) => {
      expect(new URL(url).hostname).toBe('127.0.0.1');
      await expect(resolveTarget(url, { allowlist: [], resolver: noDns })).rejects.toThrow(
        /127\.0\.0\.0\/8/,
      );
    },
  );

  it('SEC-SSRF-05 rejects a disallowed scheme and credentials before any DNS lookup', async () => {
    const resolver = stubResolver([PUBLIC_V4]);
    for (const url of ['ftp://example.com/', 'file:///etc/passwd', 'http://u:p@example.com/']) {
      await expect(resolveTarget(url, { allowlist: [], resolver })).rejects.toThrow(
        SsrfBlockedError,
      );
    }
    expect(resolver.calls).toEqual([]);
  });

  it('SEC-SSRF-06 blocks a hostname that resolves to one public and one private address', async () => {
    await expect(
      resolveTarget('http://mixed.example/', {
        allowlist: [],
        resolver: stubResolver([PUBLIC_V4, PRIVATE_V4]),
      }),
    ).rejects.toThrow(/10\.0\.0\.5.*10\.0\.0\.0\/8/);

    // The order of the records must not matter.
    await expect(
      resolveTarget('http://mixed.example/', {
        allowlist: [],
        resolver: stubResolver([PRIVATE_V4, PUBLIC_V4]),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it('SEC-SSRF-12 a host in SSRF_ALLOWLIST that resolves to loopback is allowed', async () => {
    const target = await resolveTarget('http://mock-receiver:4000/hook/demo', {
      allowlist: ['mock-receiver'],
      resolver: stubResolver([LOOPBACK_V4]),
    });
    expect(target).toMatchObject({ address: '127.0.0.1', allowlisted: true });

    // An allowlisted IP literal works the same way, and the match ignores case.
    const literal = await resolveTarget('http://127.0.0.1:4000/', {
      allowlist: ['127.0.0.1'],
      resolver: noDns,
    });
    expect(literal.allowlisted).toBe(true);
    const upper = await resolveTarget('http://MOCK-RECEIVER/', {
      allowlist: ['mock-receiver'],
      resolver: stubResolver([LOOPBACK_V4]),
    });
    expect(upper.allowlisted).toBe(true);
  });

  it('AC9.4 SEC-SSRF-12 the allowlist skips the address check only: ftp: and credentials are still refused', async () => {
    const options = { allowlist: ['mock-receiver'], resolver: stubResolver([LOOPBACK_V4]) };

    await expect(resolveTarget('ftp://mock-receiver/', options)).rejects.toThrow(SsrfBlockedError);
    await expect(resolveTarget('http://u:p@mock-receiver/', options)).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it('SEC-SSRF-12 the allowlist match is exact: a subdomain or a trailing dot is not on the list', async () => {
    const resolver = stubResolver([LOOPBACK_V4]);
    for (const url of [
      'http://evil.mock-receiver/',
      'http://mock-receiver./',
      'http://mock-receiver.evil.example/',
    ]) {
      await expect(resolveTarget(url, { allowlist: ['mock-receiver'], resolver })).rejects.toThrow(
        SsrfBlockedError,
      );
    }
  });

  it('SEC-SSRF-13 with an empty allowlist, localhost is blocked', async () => {
    await expect(
      resolveTarget('http://localhost:4000/', {
        allowlist: [],
        resolver: stubResolver([{ address: '::1', family: 6 }, LOOPBACK_V4]),
      }),
    ).rejects.toThrow(SsrfBlockedError);

    // The same through the operating system's resolver, which answers "localhost" without a network.
    await expect(resolveTarget('http://localhost:4000/', { allowlist: [] })).rejects.toThrow(
      SsrfBlockedError,
    );
  });

  it('pins the IPv4 address of a dual-stack host, whatever order DNS answers in (ADR-0019)', async () => {
    const publicV6 = { address: '2606:2800:220:1::1', family: 6 } as const;

    const v6First = await resolveTarget('http://dual.example/', {
      allowlist: [],
      resolver: stubResolver([publicV6, PUBLIC_V4]),
    });
    expect(v6First).toMatchObject({ address: PUBLIC_V4.address, family: 4 });

    // A host with only AAAA records is still reachable: the first address is used.
    const v6Only = await resolveTarget('http://v6.example/', {
      allowlist: [],
      resolver: stubResolver([publicV6]),
    });
    expect(v6Only).toMatchObject({ address: publicV6.address, family: 6 });

    // Preferring IPv4 does not weaken the check: a blocked AAAA record still rejects the host.
    await expect(
      resolveTarget('http://dual.example/', {
        allowlist: [],
        resolver: stubResolver([{ address: 'fd00::1', family: 6 }, PUBLIC_V4]),
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it('passes a DNS failure through, so the caller can tell it from a blocked address', async () => {
    const dnsFailure = Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), {
      code: 'ENOTFOUND',
    });
    await expect(
      resolveTarget('http://nope.invalid/', {
        allowlist: [],
        resolver: () => Promise.reject(dnsFailure),
      }),
    ).rejects.toBe(dnsFailure);
  });

  it('treats an empty DNS answer as a DNS failure', async () => {
    await expect(
      resolveTarget('http://empty.example/', { allowlist: [], resolver: stubResolver([]) }),
    ).rejects.toMatchObject({ code: 'ENOTFOUND' });
  });
});

describe('systemResolver', () => {
  it('resolves localhost to loopback addresses with a family of 4 or 6', async () => {
    const addresses = await systemResolver('localhost');

    expect(addresses.length).toBeGreaterThan(0);
    for (const { address, family } of addresses) {
      expect(['127.0.0.1', '::1']).toContain(address);
      expect([4, 6]).toContain(family);
    }
  });
});

describe('validateDestinationUrl (the create-time check behind 422 DESTINATION_URL_NOT_ALLOWED)', () => {
  it('AC9.1 SEC-SSRF-11 refuses http://169.254.169.254/ (the HTTP endpoint that returns 422 is Day 3)', async () => {
    const check = await validateDestinationUrl('http://169.254.169.254/', {
      allowlist: [],
      resolver: noDns,
    });

    expect(check.ok).toBe(false);
    expect(check).toMatchObject({ reason: expect.stringContaining('169.254.0.0/16') as string });
  });

  it('accepts a URL whose host resolves to public addresses only', async () => {
    expect(
      await validateDestinationUrl('https://orders.example.com/webhooks', {
        allowlist: [],
        resolver: stubResolver([PUBLIC_V4, PUBLIC_V6]),
      }),
    ).toEqual({ ok: true });
  });

  it('refuses a hostname that does not resolve, without leaking the resolver error', async () => {
    const check = await validateDestinationUrl('https://nope.invalid/', {
      allowlist: [],
      resolver: () => Promise.reject(new Error('getaddrinfo ENOTFOUND nope.invalid')),
    });
    expect(check).toEqual({ ok: false, reason: 'The hostname could not be resolved.' });
  });
});
