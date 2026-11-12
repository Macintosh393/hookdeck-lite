// The mock receiver: a small HTTP server that plays the role of a subscriber's endpoint.
// Pipeline position: the far end of delivery. Day 1 has the minimal version (a status chosen by
// query parameter); the scriptable control API of docs/TESTING.md#the-mock-receiver comes on Day 2.
// It uses node:http and nothing else, so its container image needs no node_modules.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockReceiverOptions {
  /** Receives one JSON line per request. Default: write to stdout. Pass `false` to stay quiet in tests. */
  log?: ((line: string) => void) | false;
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
  close(): Promise<void>;
}

/** `?status=503` picks the response status. Anything that is not a real status code is ignored. */
function statusFromQuery(url: URL): number {
  const value = url.searchParams.get('status');
  if (value === null || !/^\d{3}$/.test(value)) return 200;
  const status = Number(value);
  return status >= 200 && status <= 599 ? status : 200;
}

/** Reads the request to its end and returns how many bytes the body had. */
function consumeBody(request: IncomingMessage): Promise<number> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    request.on('end', () => resolve(bytes));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function createMockReceiver(options: MockReceiverOptions = {}): MockReceiver {
  const log =
    options.log === false
      ? () => {}
      : (options.log ?? ((line: string) => process.stdout.write(`${line}\n`)));

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // The base is only there because URL needs one to parse a path.
    const url = new URL(request.url ?? '/', 'http://mock-receiver');
    const method = request.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    const hook = /^\/hook\/([^/]+)$/.exec(url.pathname);
    if (!hook) {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    if (method !== 'POST') {
      sendJson(response, 405, { error: 'method not allowed' });
      return;
    }

    const bodyBytes = await consumeBody(request);
    const status = statusFromQuery(url);
    sendJson(response, status, { ok: status < 400 });

    // Header values only. The body may hold a tenant's data and is not logged.
    log(
      JSON.stringify({
        time: new Date().toISOString(),
        msg: 'delivery received',
        bucket: decodeURIComponent(hook[1] ?? ''),
        status,
        bodyBytes,
        webhookId: request.headers['webhook-id'] ?? null,
        deliveryId: request.headers['x-hdl-delivery-id'] ?? null,
        attempt: request.headers['x-hdl-attempt'] ?? null,
      }),
    );
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
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

    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // close() waits for open keep-alive connections; this ends the idle ones right away.
        server.closeIdleConnections();
      });
    },
  };

  return receiver;
}
