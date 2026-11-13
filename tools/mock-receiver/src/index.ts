// The mock receiver: a small HTTP server that plays a subscriber's endpoint and behaves as badly
// as it is told to. Pipeline position: the far end of delivery.
// It is used three ways: in-process in tests (createMockReceiver), as the docker-compose service
// for demos, and as the public demo destination. Spec: docs/TESTING.md#the-mock-receiver
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Webhook } from 'standardwebhooks';

/** One scripted answer. */
export interface ScenarioResponse {
  status: number;
  /** Adds a `Retry-After` header, in seconds. */
  retryAfter?: number;
  /** Waits this long before answering. */
  delayMs?: number;
  /** The response body. Default: `{"ok":true}` or `{"ok":false}`. */
  body?: string;
}

export interface Scenario {
  /** Consumed in order, one per request. */
  responses?: ScenarioResponse[];
  /** Used when `responses` is exhausted or absent. Default: { status: 200 }. */
  default?: ScenarioResponse;
  /** If set, each recorded request gets `signatureValid`, checked with the standardwebhooks package. */
  verifySecret?: string;
}

export interface RecordedRequest {
  receivedAt: string;
  headers: Record<string, string>;
  /** Exactly as received. */
  body: string;
  signatureValid?: boolean;
}

export interface MockReceiverOptions {
  /** Receives one JSON line per request. Default: write to stdout. Pass `false` to stay quiet in tests. */
  log?: ((line: string) => void) | false;
  /** MOCK_FAIL_RATE: answer 500 with this probability on buckets that have no scenario. */
  failRate?: number;
  /** MOCK_LATENCY_MS: wait this long before every answer. */
  latencyMs?: number;
  /** Source of randomness for the fail rates. Default: Math.random. */
  random?: () => number;
}

export interface MockReceiver {
  /**
   * Starts listening and resolves with the receiver itself, so a test can write
   * `await createMockReceiver().listen(0)`. Port 0 asks the OS for a free port.
   * The default host is loopback only; a container must pass '0.0.0.0'.
   */
  listen(port: number, host?: string): Promise<MockReceiver>;
  /** The port in use. Throws before listen() has resolved. */
  readonly port: number;
  /** The delivery URL of a bucket: http://127.0.0.1:<port>/hook/<bucket> */
  urlFor(bucket: string): string;
  /** Sets the bucket's scenario and clears its recorded requests. Same as PUT /__control/buckets/{bucket}. */
  setScenario(bucket: string, scenario: Scenario): void;
  /** The requests the bucket received, oldest first. Same as GET /__control/buckets/{bucket}/requests. */
  requests(bucket: string): RecordedRequest[];
  /** Removes the scenario and the record. Same as DELETE /__control/buckets/{bucket}. */
  deleteBucket(bucket: string): void;
  /** Stops the server and drops every open connection, including requests that are hanging on purpose. */
  close(): Promise<void>;
}

interface Bucket {
  scenario: Scenario | null;
  /** How many of scenario.responses have been used. */
  nextResponse: number;
  requests: RecordedRequest[];
}

/** Recorded requests kept per bucket. The public demo receiver must not grow without bound. */
const MAX_RECORDED_REQUESTS = 500;
/** Largest request body read. hookdeck-lite sends at most INGEST_MAX_BODY_BYTES (1 MiB). */
const MAX_REQUEST_BODY_BYTES = 2 * 1_048_576;
const MAX_RESPONSE_BODY_BYTES = 16 * 1_048_576;
const MAX_DELAY_MS = 120_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function isStatusCode(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function isScenarioResponse(value: unknown): value is ScenarioResponse {
  if (typeof value !== 'object' || value === null) return false;
  const { status, retryAfter, delayMs, body } = value as Record<string, unknown>;
  return (
    isStatusCode(status) &&
    isOptionalNumber(retryAfter) &&
    isOptionalNumber(delayMs) &&
    (body === undefined || typeof body === 'string')
  );
}

/** Checks a scenario that arrived as JSON over the control API. Throws a 400 for a bad shape. */
export function parseScenario(value: unknown): Scenario {
  const invalid = new HttpError(400, 'invalid scenario');
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid;
  const { responses, default: fallback, verifySecret } = value as Record<string, unknown>;

  if (
    responses !== undefined &&
    !(Array.isArray(responses) && responses.every(isScenarioResponse))
  ) {
    throw invalid;
  }
  if (fallback !== undefined && !isScenarioResponse(fallback)) throw invalid;
  if (verifySecret !== undefined && typeof verifySecret !== 'string') throw invalid;

  return {
    ...(responses === undefined ? {} : { responses: responses }),
    ...(fallback === undefined ? {} : { default: fallback }),
    ...(verifySecret === undefined ? {} : { verifySecret }),
  };
}

/** Reads the request body to its end, or throws a 413 when it is larger than the limit. */
function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BODY_BYTES) {
        reject(new HttpError(413, 'body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function singleValueHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A whole number from a query parameter, or undefined when it is missing or not a number. */
function queryInt(url: URL, name: string, min: number, max: number): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= min && value <= max ? value : undefined;
}

/** What the receiver will answer to one delivery, after scenario and query parameters are combined. */
interface PlannedResponse {
  status: number;
  retryAfter?: number;
  delayMs: number;
  body?: string;
  bodyBytes?: number;
  redirectTo?: string;
  hang: boolean;
}

export function createMockReceiver(options: MockReceiverOptions = {}): MockReceiver {
  const log =
    options.log === false
      ? () => {}
      : (options.log ?? ((line: string) => process.stdout.write(`${line}\n`)));
  const random = options.random ?? Math.random;
  const buckets = new Map<string, Bucket>();

  function bucketFor(name: string): Bucket {
    let bucket = buckets.get(name);
    if (!bucket) {
      bucket = { scenario: null, nextResponse: 0, requests: [] };
      buckets.set(name, bucket);
    }
    return bucket;
  }

  /** The scenario's next scripted answer, or its default, or 200. */
  function nextScripted(bucket: Bucket): ScenarioResponse {
    const scripted = bucket.scenario?.responses?.[bucket.nextResponse];
    if (scripted) {
      bucket.nextResponse += 1;
      return scripted;
    }
    return bucket.scenario?.default ?? { status: 200 };
  }

  /** Query parameters override the scripted answer for this one request. */
  function plan(bucket: Bucket, url: URL): PlannedResponse {
    const scripted = nextScripted(bucket);
    const planned: PlannedResponse = {
      status: scripted.status,
      delayMs: (scripted.delayMs ?? 0) + (options.latencyMs ?? 0),
      hang: url.searchParams.get('hang') === '1',
      ...(scripted.retryAfter === undefined ? {} : { retryAfter: scripted.retryAfter }),
      ...(scripted.body === undefined ? {} : { body: scripted.body }),
    };

    const status = queryInt(url, 'status', 100, 599);
    const failRateRaw = url.searchParams.get('failRate');
    const failRate = failRateRaw === null ? Number.NaN : Number(failRateRaw);
    if (status !== undefined) {
      planned.status = status;
    } else if (failRate >= 0 && failRate <= 1) {
      planned.status = random() < failRate ? 500 : 200;
    } else if (bucket.scenario === null && random() < (options.failRate ?? 0)) {
      // Global chaos (MOCK_FAIL_RATE) applies only where nothing else was asked for.
      planned.status = 500;
    }

    const delayMs = queryInt(url, 'delayMs', 0, MAX_DELAY_MS);
    if (delayMs !== undefined) planned.delayMs = delayMs + (options.latencyMs ?? 0);
    const retryAfter = queryInt(url, 'retryAfter', 0, 86_400);
    if (retryAfter !== undefined) planned.retryAfter = retryAfter;
    const bodyBytes = queryInt(url, 'bodyBytes', 0, MAX_RESPONSE_BODY_BYTES);
    if (bodyBytes !== undefined) planned.bodyBytes = bodyBytes;

    const redirectTo = url.searchParams.get('redirectTo');
    if (redirectTo !== null && redirectTo !== '') {
      planned.status = 302;
      planned.redirectTo = redirectTo;
    }
    return planned;
  }

  function verifySignature(secret: string, body: string, headers: Record<string, string>): boolean {
    try {
      // The official library: it checks the three webhook-* headers, the timestamp tolerance
      // (5 minutes) and the HMAC, and throws when any of them is wrong.
      new Webhook(secret).verify(body, headers);
      return true;
    } catch {
      return false;
    }
  }

  async function handleDelivery(
    bucketName: string,
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = (await readBody(request)).toString('utf8');
    const headers = singleValueHeaders(request);
    const bucket = bucketFor(bucketName);

    const recorded: RecordedRequest = { receivedAt: new Date().toISOString(), headers, body };
    const secret = bucket.scenario?.verifySecret;
    if (secret !== undefined) recorded.signatureValid = verifySignature(secret, body, headers);
    bucket.requests.push(recorded);
    if (bucket.requests.length > MAX_RECORDED_REQUESTS) bucket.requests.shift();

    const planned = plan(bucket, url);

    // Header values only. The body may hold a tenant's data and is not logged.
    log(
      JSON.stringify({
        time: recorded.receivedAt,
        msg: 'delivery received',
        bucket: bucketName,
        status: planned.hang ? null : planned.status,
        bodyBytes: Buffer.byteLength(body),
        webhookId: headers['webhook-id'] ?? null,
        deliveryId: headers['x-hdl-delivery-id'] ?? null,
        attempt: headers['x-hdl-attempt'] ?? null,
        ...(recorded.signatureValid === undefined
          ? {}
          : { signatureValid: recorded.signatureValid }),
      }),
    );

    // hang=1: the connection stays open and nothing is ever sent. The sender's timeout must end it.
    if (planned.hang) return;
    if (planned.delayMs > 0) await wait(planned.delayMs);
    if (response.destroyed) return; // the sender gave up while we were waiting

    const extraHeaders: Record<string, string> = {};
    if (planned.retryAfter !== undefined) extraHeaders['retry-after'] = String(planned.retryAfter);
    if (planned.redirectTo !== undefined) extraHeaders.location = planned.redirectTo;

    if (planned.bodyBytes !== undefined) {
      response.writeHead(planned.status, {
        'content-type': 'text/plain',
        'content-length': planned.bodyBytes,
        ...extraHeaders,
      });
      response.end(Buffer.alloc(planned.bodyBytes, 'x'));
      return;
    }

    const payload = planned.body ?? JSON.stringify({ ok: planned.status < 400 });
    response.writeHead(planned.status, {
      'content-type': planned.body === undefined ? 'application/json' : 'text/plain',
      'content-length': Buffer.byteLength(payload),
      ...extraHeaders,
    });
    response.end(payload);
  }

  async function handleControl(
    bucketName: string,
    tail: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = request.method ?? 'GET';

    if (tail === '/requests' && method === 'GET') {
      sendJson(response, 200, receiver.requests(bucketName));
      return;
    }
    if (tail === '' && method === 'PUT') {
      let parsed: unknown;
      try {
        parsed = JSON.parse((await readBody(request)).toString('utf8'));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, 'body is not valid JSON');
      }
      receiver.setScenario(bucketName, parseScenario(parsed));
      sendJson(response, 200, { ok: true });
      return;
    }
    if (tail === '' && method === 'DELETE') {
      receiver.deleteBucket(bucketName);
      response.writeHead(204).end();
      return;
    }
    throw new HttpError(tail === '' || tail === '/requests' ? 405 : 404, 'not found');
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // The base is only there because URL needs one to parse a path.
    const url = new URL(request.url ?? '/', 'http://mock-receiver');
    const method = request.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    const control = /^\/__control\/buckets\/([^/]+)(\/requests)?$/.exec(url.pathname);
    if (control) {
      await handleControl(
        decodeURIComponent(control[1] ?? ''),
        control[2] ?? '',
        request,
        response,
      );
      return;
    }

    const hook = /^\/hook\/([^/]+)$/.exec(url.pathname);
    if (!hook) throw new HttpError(404, 'not found');
    if (method !== 'POST') throw new HttpError(405, 'method not allowed');
    await handleDelivery(decodeURIComponent(hook[1] ?? ''), url, request, response);
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (error instanceof HttpError && !response.headersSent) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      // The client went away mid-request. There is nobody left to answer.
      response.destroy();
    });
  });

  const receiver: MockReceiver = {
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(receiver);
        });
      });
    },

    get port(): number {
      const address = server.address() as AddressInfo | null;
      if (!address) throw new Error('The mock receiver is not listening');
      return address.port;
    },

    urlFor(bucket) {
      return `http://127.0.0.1:${receiver.port}/hook/${encodeURIComponent(bucket)}`;
    },

    setScenario(bucket, scenario) {
      buckets.set(bucket, { scenario, nextResponse: 0, requests: [] });
    },

    requests(bucket) {
      return (buckets.get(bucket)?.requests ?? []).map((request) => ({
        ...request,
        headers: { ...request.headers },
      }));
    },

    deleteBucket(bucket) {
      buckets.delete(bucket);
    },

    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // close() alone waits for open connections. Requests that hang on purpose (hang=1, or a
        // long delayMs) would keep it waiting forever, so drop every connection.
        server.closeAllConnections();
      });
    },
  };

  return receiver;
}
