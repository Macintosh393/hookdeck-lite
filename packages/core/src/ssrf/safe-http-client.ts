// The SSRF-safe HTTP client: the only code in the repository that sends a request to a
// tenant-supplied URL. Pipeline position: delivery, the actual HTTP attempt.
// It implements rules 1–9 of docs/SECURITY.md#rules: scheme and address checks, IP pinning,
// no redirects, one timeout for the whole request, and a cap on the response read.
import type { LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import { Agent, request as undiciRequest } from 'undici';
import type { TransportErrorCode } from '../delivery/classify.js';
import { resolveTarget, SsrfBlockedError } from './resolve-target.js';
import type { ResolvedTarget, Resolver } from './resolve-target.js';

export interface SafeHttpClientOptions {
  /** SSRF_ALLOWLIST. Empty in production. */
  allowlist: readonly string[];
  /** DELIVERY_TIMEOUT_MS: DNS, connect, headers and body together. */
  timeoutMs: number;
  /** DELIVERY_MAX_RESPONSE_BYTES: how much of the response body is read and returned. */
  maxResponseBytes: number;
  /** DNS resolver. Default: the operating system's. Tests inject a stub. */
  resolver?: Resolver;
}

export interface SafeHttpRequest {
  url: string;
  headers: Record<string, string>;
  /** Sent as it is. A string is encoded as UTF-8. */
  body: string | Buffer;
}

export interface SafeHttpResponse {
  kind: 'response';
  statusCode: number;
  headers: Record<string, string>;
  /** At most maxResponseBytes, decoded as UTF-8. */
  body: string;
  bodyTruncated: boolean;
  /** The IP address the connection was pinned to. */
  resolvedIp: string;
  durationMs: number;
}

export interface SafeHttpFailure {
  kind: 'error';
  errorCode: TransportErrorCode;
  errorMessage: string;
  /** Null when the request failed before an address was chosen. */
  resolvedIp: string | null;
  durationMs: number;
}

export type SafeHttpResult = SafeHttpResponse | SafeHttpFailure;

export interface SafeHttpClient {
  /** Sends one POST. Never throws: every failure comes back as a `kind: 'error'` result. */
  post(request: SafeHttpRequest): Promise<SafeHttpResult>;
}

const MAX_ERROR_MESSAGE_LENGTH = 300;

const DNS_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'ENODATA']);
const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
/** OpenSSL's certificate verification failures, as Node reports them in `error.code`. */
const TLS_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'EPROTO',
]);

/** The error and everything it wraps: undici and Node nest the real cause one or two levels down. */
function errorChain(error: unknown): Array<{ code?: unknown; name?: unknown; message?: unknown }> {
  const chain: Array<{ code?: unknown; name?: unknown; message?: unknown }> = [];
  const queue: unknown[] = [error];
  while (queue.length > 0 && chain.length < 10) {
    const current = queue.shift();
    if (typeof current !== 'object' || current === null) continue;
    chain.push(current);
    const { cause, errors } = current as { cause?: unknown; errors?: unknown };
    if (cause !== undefined) queue.push(cause);
    // AggregateError: Node tried several addresses (IPv4 and IPv6) and each one failed.
    if (Array.isArray(errors)) queue.push(...(errors as unknown[]));
  }
  return chain;
}

/**
 * Maps whatever a failed request threw to one of our transport error codes.
 * Exported for its unit tests. `timedOut` is true when our own AbortSignal fired.
 */
export function mapRequestError(
  error: unknown,
  timedOut: boolean,
): { errorCode: TransportErrorCode; errorMessage: string } {
  const chain = errorChain(error);
  const codes = chain.map((entry) => (typeof entry.code === 'string' ? entry.code : ''));
  const messages = chain
    .map((entry) => (typeof entry.message === 'string' ? entry.message : ''))
    .filter((message) => message !== '');
  const errorMessage = (messages.join(': ') || 'Request failed').slice(0, MAX_ERROR_MESSAGE_LENGTH);

  let errorCode: TransportErrorCode = 'NETWORK_ERROR';
  if (error instanceof SsrfBlockedError) errorCode = 'SSRF_BLOCKED';
  else if (timedOut || codes.some((code) => TIMEOUT_ERROR_CODES.has(code))) errorCode = 'TIMEOUT';
  else if (codes.some((code) => DNS_ERROR_CODES.has(code))) errorCode = 'DNS_ERROR';
  else if (
    codes.some(
      (code) =>
        TLS_ERROR_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_'),
    )
  ) {
    errorCode = 'TLS_ERROR';
  }
  return { errorCode, errorMessage };
}

/**
 * The `lookup` function handed to the socket. It does not ask DNS anything: it answers with the
 * address that resolveTarget() already checked.
 */
function pinnedLookup(target: ResolvedTarget): LookupFunction {
  // LEARN: IP pinning. If the HTTP client resolved the hostname again here, an attacker's DNS
  // could answer "public IP" for our check and "127.0.0.1" for the connection (DNS rebinding).
  // Returning the checked address means there is no second lookup to lie to. TLS still uses the
  // hostname for SNI and the certificate. See docs/learning/ssrf-and-network-security.md#ip-pinning
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options.all === true) {
      callback(null, [{ address: target.address, family: target.family }]);
    } else {
      callback(null, target.address, target.family);
    }
  };
}

/** Rejects when `signal` aborts. DNS lookups cannot be cancelled, so the timeout races them. */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const onAbort = (): void => reject(new Error('The request timed out'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Reads at most `maxBytes` of the body, then stops and destroys the stream. */
async function readCapped(
  body: Readable,
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    if (size + chunk.length > maxBytes) {
      chunks.push(chunk.subarray(0, maxBytes - size));
      truncated = true;
      // Leaving a `for await` early destroys the stream, so the rest is never downloaded.
      break;
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

/** Postgres text and jsonb columns cannot hold a NUL character; a response body may contain one. */
function toStorableText(bytes: Buffer): string {
  return new TextDecoder('utf-8').decode(bytes).replaceAll('\u0000', '�');
}

function flattenHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    flat[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return flat;
}

export function createSafeHttpClient(options: SafeHttpClientOptions): SafeHttpClient {
  return {
    async post(request) {
      const startedAt = performance.now();
      const elapsed = (): number => Math.round(performance.now() - startedAt);
      // One clock for the whole request: DNS, connect, headers and body all count against it.
      const signal = AbortSignal.timeout(options.timeoutMs);
      let resolvedIp: string | null = null;
      let agent: Agent | undefined;

      try {
        const target = await Promise.race([
          resolveTarget(request.url, { allowlist: options.allowlist, resolver: options.resolver }),
          rejectOnAbort(signal),
        ]);
        resolvedIp = target.address;

        // A new Agent per request: its only connection is the pinned one, and destroying it
        // afterwards is what "read N bytes, then drop the connection" needs.
        agent = new Agent({
          connect: { lookup: pinnedLookup(target), timeout: options.timeoutMs },
          headersTimeout: options.timeoutMs,
          bodyTimeout: options.timeoutMs,
          allowH2: false,
          pipelining: 0,
        });

        // undici.request() never follows a redirect by itself: a 3xx comes back as a response.
        const response = await undiciRequest(target.url, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
          dispatcher: agent,
          signal,
        });
        const { bytes, truncated } = await readCapped(response.body, options.maxResponseBytes);

        return {
          kind: 'response',
          statusCode: response.statusCode,
          headers: flattenHeaders(response.headers),
          body: toStorableText(bytes),
          bodyTruncated: truncated,
          resolvedIp,
          durationMs: elapsed(),
        };
      } catch (error) {
        return {
          kind: 'error',
          ...mapRequestError(error, signal.aborted),
          resolvedIp,
          durationMs: elapsed(),
        };
      } finally {
        // destroy(), not close(): close() would wait for a response we have stopped reading.
        await agent?.destroy().catch(() => {});
      }
    },
  };
}
