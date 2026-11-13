// Turns a tenant-supplied URL into "the one IP address we are allowed to connect to".
// Rules 1–4 and 9 of docs/SECURITY.md#rules: scheme, no credentials, resolve, check every address.
// Pipeline position: delivery (the SSRF-safe client calls it for every attempt) and destination
// create/update in the api (validateDestinationUrl).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { blockedAddressReason } from './address-check.js';

/** Thrown when a URL or the address behind it breaks an SSRF rule. Never retried. */
export class SsrfBlockedError extends Error {
  readonly code = 'SSRF_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Looks a hostname up. Tests inject a stub; production uses the operating system's resolver. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** `dns.lookup(host, { all: true })`: every A and AAAA record, the same way Node itself resolves. */
export const systemResolver: Resolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true });
  return addresses.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

export interface ResolveTargetOptions {
  /** SSRF_ALLOWLIST: lowercased hostnames that skip the address check, and nothing else. */
  allowlist: readonly string[];
  resolver?: Resolver;
}

export interface ResolvedTarget {
  url: URL;
  /** The hostname without the brackets of an IPv6 literal. */
  hostname: string;
  /** The address the connection must be pinned to. It has passed the blocklist. */
  address: string;
  family: 4 | 6;
  /** True when the hostname is in SSRF_ALLOWLIST and the address check was skipped. */
  allowlisted: boolean;
}

/** Rules 1 and 2: the checks that need no network. Returns the parsed URL or throws. */
export function parseTargetUrl(rawUrl: string): URL {
  let url: URL;
  try {
    // The WHATWG parser also normalises encoding tricks: http://2130706433/, http://0x7f.0.0.1/
    // and http://017700000001/ all come out with hostname "127.0.0.1".
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('The URL is not valid.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`The scheme "${url.protocol}" is not allowed. Use http or https.`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new SsrfBlockedError('The URL must not contain credentials.');
  }
  if (rawUrl.includes('#')) {
    throw new SsrfBlockedError('The URL must not contain a fragment.');
  }
  // The parser already refuses ports above 65535. An empty port means the scheme's default.
  if (url.port === '0') {
    throw new SsrfBlockedError('The port must be between 1 and 65535.');
  }
  return url;
}

/**
 * Applies rules 1–4 (and the allowlist exception, rule 9) and returns the address to pin.
 * Throws SsrfBlockedError for a rule violation, or the resolver's own error (ENOTFOUND,
 * EAI_AGAIN) when DNS fails, so the caller can tell "refused" from "could not look it up".
 */
export async function resolveTarget(
  rawUrl: string,
  options: ResolveTargetOptions,
): Promise<ResolvedTarget> {
  const url = parseTargetUrl(rawUrl);
  // URL keeps the brackets of an IPv6 literal: "[::1]". DNS and the blocklist want "::1".
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const allowlisted = options.allowlist.includes(hostname.toLowerCase());

  // An IP literal is not looked up; it is the address. (Node also skips `lookup` for these,
  // which is why the check cannot live only inside the socket's lookup function.)
  const literalFamily = isIP(hostname);
  const candidates: ResolvedAddress[] =
    literalFamily !== 0
      ? [{ address: hostname, family: literalFamily === 6 ? 6 : 4 }]
      : await (options.resolver ?? systemResolver)(hostname);

  const first = candidates[0];
  if (first === undefined) {
    const error = new Error(
      `DNS lookup for ${hostname} returned no address`,
    ) as NodeJS.ErrnoException;
    error.code = 'ENOTFOUND';
    throw error;
  }

  if (!allowlisted) {
    // Every address, not just the one we will use: an attacker who controls the DNS zone can
    // mix one public and one private record and hope we pick the private one.
    for (const candidate of candidates) {
      const reason = blockedAddressReason(candidate.address);
      if (reason !== null) {
        throw new SsrfBlockedError(
          `${hostname} resolves to ${candidate.address}, which is in a blocked range: ${reason}.`,
        );
      }
    }
  }

  // Pinning means one address, so there is no "try IPv6, fall back to IPv4" as a browser does.
  // Prefer IPv4: a host that publishes both records is far more often unreachable over IPv6
  // (no route from this network, or a server bound to 127.0.0.1 while `localhost` resolves to
  // ::1 first) than over IPv4. Every address was checked above, so the choice is only about
  // reachability. See docs/adr/0019-pin-ipv4-first.md
  const pinned = candidates.find((candidate) => candidate.family === 4) ?? first;

  return { url, hostname, address: pinned.address, family: pinned.family, allowlisted };
}

export type DestinationUrlCheck = { ok: true } | { ok: false; reason: string };

/**
 * The create/update-time check for the api (`422 DESTINATION_URL_NOT_ALLOWED`). A courtesy to
 * the user: the check that actually protects us runs again at every delivery, because DNS
 * answers can change. A DNS failure here also counts as "not allowed".
 */
export async function validateDestinationUrl(
  rawUrl: string,
  options: ResolveTargetOptions,
): Promise<DestinationUrlCheck> {
  try {
    await resolveTarget(rawUrl, options);
    return { ok: true };
  } catch (error) {
    if (error instanceof SsrfBlockedError) return { ok: false, reason: error.message };
    return { ok: false, reason: 'The hostname could not be resolved.' };
  }
}
