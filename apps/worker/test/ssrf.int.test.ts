// Integration tests for the SSRF rules as the worker applies them at delivery time:
// SEC-SSRF-08, 09 and 10 (docs/SECURITY.md#security-test-checklist), plus blocked addresses end
// to end. The destination is the mock receiver; `127.0.0.1` is on the test allowlist.
import { createMockReceiver } from '@hdl/mock-receiver';
import type { MockReceiver } from '@hdl/mock-receiver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTenant,
  createTestWorker,
  enqueueDeliveryJob,
  waitForTerminalDelivery,
} from './helpers.js';
import type { TestTenant, TestWorker } from './helpers.js';

describe('SSRF protection at delivery time', () => {
  let worker: TestWorker;
  /** The same worker configuration with an empty SSRF_ALLOWLIST, as in production. */
  let strictWorker: TestWorker;
  let receiver: MockReceiver;
  let tenant: TestTenant;

  beforeAll(async () => {
    // A short timeout so the "never responds" case takes a fraction of a second, not 15.
    worker = await createTestWorker({ DELIVERY_TIMEOUT_MS: '300' });
    strictWorker = await createTestWorker({ SSRF_ALLOWLIST: '' });
    receiver = await createMockReceiver({ log: false }).listen(0);
    tenant = await createTenant(worker.prisma, worker.env);
  });

  afterAll(async () => {
    await tenant.remove();
    await worker.close();
    await strictWorker.close();
    await receiver.close();
  });

  async function deliverTo(url: string, via: TestWorker = worker) {
    const destination = await tenant.addDestination({ url });
    const event = await tenant.createEvent();
    const delivery = await tenant.createDelivery(event, destination);
    await enqueueDeliveryJob(via.ctx, delivery);
    return waitForTerminalDelivery(via.prisma, delivery.id);
  }

  it('SEC-SSRF-08 a 302 to http://127.0.0.1 is not followed: PERMANENT_FAILURE / REDIRECT_NOT_FOLLOWED', async () => {
    const internal = `http://127.0.0.1:${receiver.port}/hook/internal-only`;

    const done = await deliverTo(
      `${receiver.urlFor('redirecting')}?redirectTo=${encodeURIComponent(internal)}`,
    );

    expect(done).toMatchObject({
      status: 'DEAD',
      deadReason: 'PERMANENT_FAILURE',
      attemptCount: 1,
      lastStatusCode: 302,
      lastErrorCode: 'REDIRECT_NOT_FOLLOWED',
    });
    expect(done.attempts[0]).toMatchObject({
      outcome: 'PERMANENT_FAILURE',
      errorCode: 'REDIRECT_NOT_FOLLOWED',
      statusCode: 302,
    });
    expect(done.attempts[0]?.responseHeaders).toMatchObject({ location: internal });
    expect(receiver.requests('redirecting')).toHaveLength(1);
    // The place the redirect pointed at was never contacted.
    expect(receiver.requests('internal-only')).toEqual([]);
  });

  it('SEC-SSRF-09 a destination that never responds is cut off at the timeout → TIMEOUT', async () => {
    const started = Date.now();

    const done = await deliverTo(`${receiver.urlFor('hanging')}?hang=1`);

    // Four attempts of 300 ms each, plus the short test backoff: far below one real timeout of 15 s.
    expect(Date.now() - started).toBeLessThan(8000);
    expect(done).toMatchObject({
      status: 'DEAD',
      deadReason: 'RETRIES_EXHAUSTED',
      attemptCount: 4,
      lastErrorCode: 'TIMEOUT',
      lastStatusCode: null,
    });
    for (const attempt of done.attempts) {
      expect(attempt).toMatchObject({
        outcome: 'RETRYABLE_FAILURE',
        errorCode: 'TIMEOUT',
        statusCode: null,
        resolvedIp: '127.0.0.1',
      });
      expect(attempt.durationMs).toBeGreaterThanOrEqual(250);
      expect(attempt.durationMs).toBeLessThan(2000);
    }
  });

  it('SEC-SSRF-10 a 1 MiB response is truncated to DELIVERY_MAX_RESPONSE_BYTES with responseBodyTruncated = true', async () => {
    const done = await deliverTo(`${receiver.urlFor('huge')}?bodyBytes=1048576`);

    expect(worker.env.DELIVERY_MAX_RESPONSE_BYTES).toBe(16_384);
    // The status code decides the outcome; a large body is not a failure.
    expect(done).toMatchObject({ status: 'SUCCEEDED', attemptCount: 1 });
    expect(done.attempts[0]?.responseBodyTruncated).toBe(true);
    expect(Buffer.byteLength(done.attempts[0]?.responseBody ?? '')).toBe(16_384);
  });

  it.each([
    ['the cloud metadata endpoint', 'http://169.254.169.254/latest/meta-data/'],
    ['a private address', 'http://10.0.0.5:8080/internal'],
    ['IPv6 loopback', 'http://[::1]:6379/'],
    ['an IPv4-mapped loopback address', 'http://[::ffff:127.0.0.1]/'],
    ['a decimal-encoded loopback address', 'http://2130706433/'],
  ])(
    'SEC-SSRF-02 a destination at %s is SSRF_BLOCKED and DEAD after one attempt',
    async (_label, url) => {
      // Through the worker with the empty allowlist, as in production. The test allowlist holds
      // `127.0.0.1`, and the URL parser turns the decimal form into exactly that hostname.
      const done = await deliverTo(url, strictWorker);

      expect(done).toMatchObject({
        status: 'DEAD',
        deadReason: 'PERMANENT_FAILURE',
        attemptCount: 1,
        lastErrorCode: 'SSRF_BLOCKED',
        lastStatusCode: null,
      });
      expect(done.attempts[0]).toMatchObject({
        outcome: 'PERMANENT_FAILURE',
        errorCode: 'SSRF_BLOCKED',
        statusCode: null,
        resolvedIp: null,
        responseBody: null,
      });
      expect(done.attempts[0]?.errorMessage).toContain('blocked range');
    },
  );

  it('SEC-SSRF-05 a destination with a non-http scheme is SSRF_BLOCKED', async () => {
    const done = await deliverTo('ftp://127.0.0.1/file');

    expect(done).toMatchObject({ status: 'DEAD', lastErrorCode: 'SSRF_BLOCKED', attemptCount: 1 });
  });

  it('SEC-SSRF-13 with an empty allowlist, a delivery to localhost is blocked and nothing reaches the receiver', async () => {
    const byIp = await deliverTo(receiver.urlFor('strict-ip'), strictWorker);
    const byName = await deliverTo(
      `http://localhost:${receiver.port}/hook/strict-name`,
      strictWorker,
    );

    for (const done of [byIp, byName]) {
      expect(done).toMatchObject({
        status: 'DEAD',
        deadReason: 'PERMANENT_FAILURE',
        lastErrorCode: 'SSRF_BLOCKED',
      });
    }
    expect(receiver.requests('strict-ip')).toEqual([]);
    expect(receiver.requests('strict-name')).toEqual([]);
  });

  it('SEC-SSRF-12 with localhost on the allowlist, the same delivery succeeds', async () => {
    const done = await deliverTo(`http://localhost:${receiver.port}/hook/allowed-name`);

    expect(done).toMatchObject({ status: 'SUCCEEDED', attemptCount: 1 });
    expect(receiver.requests('allowed-name')).toHaveLength(1);
    // The Host header is the name that was configured, not the pinned IP.
    expect(receiver.requests('allowed-name')[0]?.headers.host).toBe(`localhost:${receiver.port}`);
  });
});
