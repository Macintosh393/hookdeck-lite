// Tests for the SSRF-safe HTTP client. DNS is a stub resolver; the "destination" is a real HTTP
// server on a loopback port, because pinning, timeouts and truncation are properties of real
// sockets. No request leaves the machine.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createSafeHttpClient, mapRequestError } from './safe-http-client.js';
import { SsrfBlockedError } from './resolve-target.js';
import type { ResolvedAddress, Resolver } from './resolve-target.js';

interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
  /** The local address the connection arrived on: which IP the client really connected to. */
  localAddress: string;
}

interface TestServer {
  port: number;
  seen: SeenRequest[];
  close(): Promise<void>;
}

const servers: TestServer[] = [];

/** Starts an HTTP server on 127.0.0.1 with a free port. `respond` decides each answer. */
async function startServer(
  respond: (request: SeenRequest, response: ServerResponse) => void,
): Promise<TestServer> {
  const seen: SeenRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry: SeenRequest = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        localAddress: request.socket.localAddress ?? '',
      };
      seen.push(entry);
      respond(entry, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const testServer: TestServer = {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  servers.push(testServer);
  return testServer;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const ok = (_request: SeenRequest, response: ServerResponse): void => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end('{"ok":true}');
};

const LOOPBACK: ResolvedAddress = { address: '127.0.0.1', family: 4 };

/** Answers from a list, one answer per call, and records the hostnames it was asked for. */
function stubResolver(...answers: ResolvedAddress[][]): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const resolver = (hostname: string): Promise<ResolvedAddress[]> => {
    calls.push(hostname);
    return Promise.resolve(answers[Math.min(calls.length, answers.length) - 1] ?? []);
  };
  return Object.assign(resolver, { calls });
}

const defaults = { allowlist: ['127.0.0.1'], timeoutMs: 5000, maxResponseBytes: 16_384 };

describe('createSafeHttpClient', () => {
  it('POSTs the body and headers as given and returns status, headers, body and the pinned IP', async () => {
    const server = await startServer(ok);
    const client = createSafeHttpClient(defaults);
    const body = '{"type":"order.created","note":"ünïcödé ✓"}';

    const result = await client.post({
      url: `http://127.0.0.1:${server.port}/hook/orders?x=1`,
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'evt_1',
        'user-agent': 'hookdeck-lite/1.0',
      },
      body,
    });

    expect(result).toMatchObject({
      kind: 'response',
      statusCode: 200,
      body: '{"ok":true}',
      bodyTruncated: false,
      resolvedIp: '127.0.0.1',
    });
    if (result.kind !== 'response') throw new Error('expected a response');
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]).toMatchObject({ method: 'POST', url: '/hook/orders?x=1', body });
    expect(server.seen[0]?.headers).toMatchObject({
      'content-type': 'application/json',
      'webhook-id': 'evt_1',
      'user-agent': 'hookdeck-lite/1.0',
      'content-length': String(Buffer.byteLength(body)),
    });
  });

  it('sends a Buffer body byte for byte', async () => {
    const server = await startServer(ok);
    const bytes = Buffer.from('{"a":"é"}', 'utf8');

    await createSafeHttpClient(defaults).post({
      url: `http://127.0.0.1:${server.port}/`,
      headers: {},
      body: bytes,
    });

    expect(Buffer.from(server.seen[0]?.body ?? '', 'utf8').equals(bytes)).toBe(true);
  });

  it('AC9.2 SEC-SSRF-07 DNS rebinding: the connection goes to the first resolved IP and the resolver is called once', async () => {
    const server = await startServer(ok);
    // First answer: the address that is checked. Second answer: what a rebinding attacker would
    // serve to a client that resolves again at connect time. Nothing listens on 127.0.0.2, so a
    // second lookup would make this request fail.
    //
    // A loopback address stands in for the "public" first answer, because a unit test cannot
    // connect to a real public IP. The hostname is allowlisted so that the address check lets
    // loopback through; the pinning being tested is the same code path either way.
    const resolver = stubResolver([LOOPBACK], [{ address: '127.0.0.2', family: 4 }]);
    const client = createSafeHttpClient({ ...defaults, allowlist: ['rebind.test'], resolver });

    const result = await client.post({
      url: `http://rebind.test:${server.port}/hook`,
      headers: {},
      body: '{}',
    });

    expect(result).toMatchObject({ kind: 'response', statusCode: 200, resolvedIp: '127.0.0.1' });
    expect(resolver.calls).toEqual(['rebind.test']); // exactly one lookup
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]?.localAddress).toBe('127.0.0.1');
    // The Host header is still the original hostname, not the pinned IP.
    expect(server.seen[0]?.headers.host).toBe(`rebind.test:${server.port}`);
  });

  it('SEC-SSRF-07 a hostname whose checked answer is private is refused before any connection, even if a later answer would be public', async () => {
    const server = await startServer(ok);
    const resolver = stubResolver([LOOPBACK], [{ address: '93.184.216.34', family: 4 }]);
    const client = createSafeHttpClient({ ...defaults, allowlist: [], resolver });

    const result = await client.post({
      url: `http://rebind.test:${server.port}/hook`,
      headers: {},
      body: '{}',
    });

    expect(result).toMatchObject({ kind: 'error', errorCode: 'SSRF_BLOCKED', resolvedIp: null });
    expect(resolver.calls).toHaveLength(1);
    expect(server.seen).toHaveLength(0);
  });

  it('SEC-SSRF-02 refuses a blocked IP literal without opening a connection', async () => {
    const server = await startServer(ok);
    const client = createSafeHttpClient({ ...defaults, allowlist: [] });

    const result = await client.post({
      url: `http://127.0.0.1:${server.port}/`,
      headers: {},
      body: '{}',
    });

    expect(result).toMatchObject({ kind: 'error', errorCode: 'SSRF_BLOCKED' });
    if (result.kind !== 'error') throw new Error('expected an error');
    expect(result.errorMessage).toContain('127.0.0.0/8');
    expect(server.seen).toHaveLength(0);
  });

  it('SEC-SSRF-05 refuses a non-http scheme', async () => {
    const result = await createSafeHttpClient(defaults).post({
      url: 'ftp://127.0.0.1/file',
      headers: {},
      body: '',
    });
    expect(result).toMatchObject({ kind: 'error', errorCode: 'SSRF_BLOCKED' });
  });

  it('SEC-SSRF-08 does not follow a 302: the redirect comes back as the response', async () => {
    const internal = await startServer(ok);
    const redirecting = await startServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${internal.port}/secret` });
      response.end();
    });

    const result = await createSafeHttpClient(defaults).post({
      url: `http://127.0.0.1:${redirecting.port}/hook`,
      headers: {},
      body: '{}',
    });

    expect(result).toMatchObject({ kind: 'response', statusCode: 302 });
    if (result.kind !== 'response') throw new Error('expected a response');
    expect(result.headers.location).toBe(`http://127.0.0.1:${internal.port}/secret`);
    expect(internal.seen).toHaveLength(0);
  });

  it('SEC-SSRF-09 cuts off a destination that never responds at the timeout', async () => {
    const server = await startServer(() => {
      // Accept the request and say nothing.
    });
    const client = createSafeHttpClient({ ...defaults, timeoutMs: 200 });

    const started = Date.now();
    const result = await client.post({
      url: `http://127.0.0.1:${server.port}/hang`,
      headers: {},
      body: '{}',
    });

    expect(result).toMatchObject({ kind: 'error', errorCode: 'TIMEOUT', resolvedIp: '127.0.0.1' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.durationMs).toBeGreaterThanOrEqual(150);
  });

  it('SEC-SSRF-09 the timeout also covers a body that stops halfway', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('partial');
      // Never calls end().
    });

    const result = await createSafeHttpClient({ ...defaults, timeoutMs: 200 }).post({
      url: `http://127.0.0.1:${server.port}/`,
      headers: {},
      body: '{}',
    });

    expect(result).toMatchObject({ kind: 'error', errorCode: 'TIMEOUT' });
  });

  it('SEC-SSRF-09 the timeout also covers a DNS lookup that never answers', async () => {
    const hangingResolver: Resolver = () => new Promise(() => {});

    const result = await createSafeHttpClient({
      ...defaults,
      timeoutMs: 100,
      resolver: hangingResolver,
    }).post({ url: 'http://slow-dns.test/', headers: {}, body: '{}' });

    expect(result).toMatchObject({ kind: 'error', errorCode: 'TIMEOUT', resolvedIp: null });
  });

  it('SEC-SSRF-10 truncates a 1 MiB response to maxResponseBytes and sets the flag', async () => {
    const big = Buffer.alloc(1_048_576, 'a');
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(big);
    });

    const result = await createSafeHttpClient({ ...defaults, maxResponseBytes: 16_384 }).post({
      url: `http://127.0.0.1:${server.port}/`,
      headers: {},
      body: '{}',
    });

    expect(result).toMatchObject({ kind: 'response', statusCode: 200, bodyTruncated: true });
    if (result.kind !== 'response') throw new Error('expected a response');
    expect(Buffer.byteLength(result.body)).toBe(16_384);
  });

  it('does not flag a response of exactly maxResponseBytes as truncated', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end(Buffer.alloc(100, 'b'));
    });

    const result = await createSafeHttpClient({ ...defaults, maxResponseBytes: 100 }).post({
      url: `http://127.0.0.1:${server.port}/`,
      headers: {},
      body: '{}',
    });

    expect(result).toMatchObject({ kind: 'response', bodyTruncated: false });
    if (result.kind !== 'response') throw new Error('expected a response');
    expect(result.body).toHaveLength(100);
  });

  it('replaces NUL bytes in the response body, which Postgres text cannot store', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(500);
      response.end(Buffer.from([0x61, 0x00, 0x62]));
    });

    const result = await createSafeHttpClient(defaults).post({
      url: `http://127.0.0.1:${server.port}/`,
      headers: {},
      body: '{}',
    });

    expect(result).toMatchObject({ kind: 'response', statusCode: 500, body: 'a�b' });
  });

  it('joins a repeated response header into one value', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'set-cookie': ['a=1', 'b=2'], 'Retry-After': '7' });
      response.end();
    });

    const result = await createSafeHttpClient(defaults).post({
      url: `http://127.0.0.1:${server.port}/`,
      headers: {},
      body: '{}',
    });

    if (result.kind !== 'response') throw new Error('expected a response');
    expect(result.headers['set-cookie']).toBe('a=1, b=2');
    expect(result.headers['retry-after']).toBe('7');
  });

  it('reports a refused connection as NETWORK_ERROR', async () => {
    const server = await startServer(ok);
    const { port } = server;
    await server.close(); // the port is now closed
    servers.length = 0;

    const result = await createSafeHttpClient(defaults).post({
      url: `http://127.0.0.1:${port}/`,
      headers: {},
      body: '{}',
    });

    expect(result).toMatchObject({
      kind: 'error',
      errorCode: 'NETWORK_ERROR',
      resolvedIp: '127.0.0.1',
    });
  });

  it('reports a connection closed before any response as NETWORK_ERROR', async () => {
    const server = await startServer((_request, response) => {
      response.socket?.destroy();
    });

    const result = await createSafeHttpClient(defaults).post({
      url: `http://127.0.0.1:${server.port}/`,
      headers: {},
      body: '{}',
    });

    expect(result).toMatchObject({ kind: 'error', errorCode: 'NETWORK_ERROR' });
  });

  it('reports a failed DNS lookup as DNS_ERROR', async () => {
    const failing: Resolver = () =>
      Promise.reject(
        Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), { code: 'ENOTFOUND' }),
      );

    const result = await createSafeHttpClient({ ...defaults, resolver: failing }).post({
      url: 'http://nope.invalid/',
      headers: {},
      body: '{}',
    });

    expect(result).toMatchObject({ kind: 'error', errorCode: 'DNS_ERROR', resolvedIp: null });
  });

  it('reports a failed TLS handshake as TLS_ERROR', async () => {
    // An https:// URL pointed at a server that only speaks plain HTTP: the handshake cannot succeed.
    const server = await startServer(ok);

    const result = await createSafeHttpClient(defaults).post({
      url: `https://127.0.0.1:${server.port}/`,
      headers: {},
      body: '{}',
    });

    expect(result).toMatchObject({ kind: 'error', errorCode: 'TLS_ERROR' });
  });
});

describe('mapRequestError', () => {
  const withCode = (code: string, message = code): Error =>
    Object.assign(new Error(message), { code });

  it('maps our own timeout signal to TIMEOUT whatever was thrown', () => {
    expect(mapRequestError(new Error('aborted'), true).errorCode).toBe('TIMEOUT');
  });

  it.each([
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ])('maps %s to TIMEOUT', (code) => {
    expect(mapRequestError(withCode(code), false).errorCode).toBe('TIMEOUT');
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN'])('maps %s to DNS_ERROR', (code) => {
    expect(mapRequestError(withCode(code), false).errorCode).toBe('DNS_ERROR');
  });

  it.each([
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'EPROTO',
  ])('maps %s to TLS_ERROR', (code) => {
    expect(mapRequestError(withCode(code), false).errorCode).toBe('TLS_ERROR');
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'SOMETHING_ELSE'])(
    'maps %s to NETWORK_ERROR',
    (code) => {
      expect(mapRequestError(withCode(code), false).errorCode).toBe('NETWORK_ERROR');
    },
  );

  it('maps an SsrfBlockedError to SSRF_BLOCKED, even if the timeout fired meanwhile', () => {
    expect(mapRequestError(new SsrfBlockedError('blocked'), true)).toEqual({
      errorCode: 'SSRF_BLOCKED',
      errorMessage: 'blocked',
    });
  });

  it('finds the code on a wrapped cause and inside an AggregateError', () => {
    const wrapped = new Error('fetch failed', { cause: withCode('ENOTFOUND', 'getaddrinfo') });
    expect(mapRequestError(wrapped, false)).toEqual({
      errorCode: 'DNS_ERROR',
      errorMessage: 'fetch failed: getaddrinfo',
    });

    const aggregate = new AggregateError(
      [withCode('ECONNREFUSED'), withCode('ETIMEDOUT')],
      'all failed',
    );
    expect(mapRequestError(aggregate, false).errorCode).toBe('TIMEOUT');
  });

  it('copes with a thrown value that is not an Error and caps the message length', () => {
    expect(mapRequestError('boom', false)).toEqual({
      errorCode: 'NETWORK_ERROR',
      errorMessage: 'Request failed',
    });
    expect(mapRequestError(new Error('x'.repeat(1000)), false).errorMessage).toHaveLength(300);
  });
});
