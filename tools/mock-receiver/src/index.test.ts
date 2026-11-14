// Tests for the mock receiver. They use real sockets on a free port, because the receiver's
// whole job is to be a real HTTP endpoint. Spec: docs/TESTING.md#the-mock-receiver
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockReceiver, parseScenario } from './index.js';
import type { MockReceiver, RecordedRequest } from './index.js';

describe('mock receiver', () => {
  let receiver: MockReceiver;
  let logLines: string[];

  beforeEach(async () => {
    logLines = [];
    receiver = await createMockReceiver({ log: (line) => logLines.push(line) }).listen(0);
  });

  afterEach(async () => {
    await receiver.close();
  });

  const base = (): string => `http://127.0.0.1:${receiver.port}`;

  const post = (url: string, body = '{"hello":"world"}', headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
      redirect: 'manual',
    });

  describe('delivery endpoint', () => {
    it('listens on a free port and builds bucket URLs from it', () => {
      expect(receiver.port).toBeGreaterThan(0);
      expect(receiver.urlFor('orders')).toBe(`http://127.0.0.1:${receiver.port}/hook/orders`);
    });

    it('answers POST /hook/:bucket with 200 {"ok":true} when there is no scenario', async () => {
      const response = await post(receiver.urlFor('orders'));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    });

    it('answers GET /health with 200', async () => {
      const response = await fetch(`${base()}/health`);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    });

    it('rejects other paths and methods', async () => {
      expect((await fetch(`${base()}/nope`)).status).toBe(404);
      expect((await fetch(`${base()}/hook/orders`)).status).toBe(405);
      expect((await fetch(`${base()}/__control/buckets/orders`)).status).toBe(405);
      expect((await fetch(`${base()}/__control/buckets/orders/nope`)).status).toBe(404);
    });

    it('logs one JSON line per delivery, without the body', async () => {
      await post(receiver.urlFor('orders'), '{"secret":"do-not-log"}', {
        'webhook-id': 'evt_1',
        'x-hdl-attempt': '2',
      });

      expect(logLines).toHaveLength(1);
      expect(JSON.parse(logLines[0]!)).toMatchObject({
        msg: 'delivery received',
        bucket: 'orders',
        status: 200,
        bodyBytes: 23,
        webhookId: 'evt_1',
        attempt: '2',
      });
      expect(logLines[0]).not.toContain('do-not-log');
    });

    it('refuses a request body larger than 2 MiB', async () => {
      const response = await post(receiver.urlFor('orders'), 'x'.repeat(2 * 1_048_576 + 1)).catch(
        () => null,
      );
      // Depending on timing the client sees the 413 or a reset connection. Either way nothing is recorded.
      if (response) expect(response.status).toBe(413);
      expect(receiver.requests('orders')).toEqual([]);
    });
  });

  describe('query parameters', () => {
    it('status=503 picks the response status', async () => {
      const response = await post(`${receiver.urlFor('orders')}?status=503`);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ ok: false });
    });

    it.each(['abc', '99', '700', '2000', ''])('ignores an invalid ?status=%s', async (status) => {
      const response = await post(`${receiver.urlFor('orders')}?status=${status}`);
      expect(response.status).toBe(200);
    });

    it('delayMs waits before responding', async () => {
      const started = Date.now();
      const response = await post(`${receiver.urlFor('orders')}?delayMs=150`);

      expect(response.status).toBe(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    });

    it('retryAfter adds a Retry-After header in seconds', async () => {
      const response = await post(`${receiver.urlFor('orders')}?status=429&retryAfter=5`);

      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('5');
    });

    it('bodyBytes responds with a body of that size', async () => {
      const response = await post(`${receiver.urlFor('orders')}?bodyBytes=1048576`);

      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBe(1_048_576);
    });

    it('redirectTo responds 302 with that Location', async () => {
      const response = await post(
        `${receiver.urlFor('orders')}?redirectTo=${encodeURIComponent('http://127.0.0.1/')}`,
      );

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('http://127.0.0.1/');
    });

    it('hang=1 accepts the request and never responds; close() still returns', async () => {
      const outcome = await Promise.race([
        post(`${receiver.urlFor('orders')}?hang=1`).then(
          () => 'responded',
          () => 'failed',
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 300)),
      ]);

      expect(outcome).toBe('still waiting');
      expect(receiver.requests('orders')).toHaveLength(1);
    });

    it('failRate responds 500 with that probability, else 200', async () => {
      const draws = [0.1, 0.9];
      const scripted = await createMockReceiver({
        log: false,
        random: () => draws.shift() ?? 0,
      }).listen(0);
      try {
        const first = await post(`${scripted.urlFor('orders')}?failRate=0.3`);
        const second = await post(`${scripted.urlFor('orders')}?failRate=0.3`);

        expect(first.status).toBe(500); // 0.1 < 0.3
        expect(second.status).toBe(200); // 0.9 >= 0.3
      } finally {
        await scripted.close();
      }
    });
  });

  describe('global chaos from the environment', () => {
    it('MOCK_FAIL_RATE fails buckets that have no scenario, and leaves scripted buckets alone', async () => {
      const chaotic = await createMockReceiver({ log: false, failRate: 1, latencyMs: 60 }).listen(
        0,
      );
      try {
        const started = Date.now();
        const unscripted = await post(chaotic.urlFor('plain'));
        expect(unscripted.status).toBe(500);
        expect(Date.now() - started).toBeGreaterThanOrEqual(50); // MOCK_LATENCY_MS

        chaotic.setScenario('scripted', { default: { status: 204 } });
        expect((await post(chaotic.urlFor('scripted'))).status).toBe(204);
        expect((await post(`${chaotic.urlFor('plain')}?status=201`)).status).toBe(201);
      } finally {
        await chaotic.close();
      }
    });
  });

  describe('scenarios', () => {
    it('"fail twice, then succeed": responses are consumed in order, then the default applies', async () => {
      receiver.setScenario('orders', {
        responses: [{ status: 500 }, { status: 503, retryAfter: 1 }],
        default: { status: 200 },
      });

      const first = await post(receiver.urlFor('orders'));
      const second = await post(receiver.urlFor('orders'));
      const third = await post(receiver.urlFor('orders'));
      const fourth = await post(receiver.urlFor('orders'));

      expect([first.status, second.status, third.status, fourth.status]).toEqual([
        500, 503, 200, 200,
      ]);
      expect(second.headers.get('retry-after')).toBe('1');
      expect(receiver.requests('orders')).toHaveLength(4);
    });

    it('a scenario without a default answers 200 once its responses are used up', async () => {
      receiver.setScenario('orders', { responses: [{ status: 404, body: 'gone fishing' }] });

      const first = await post(receiver.urlFor('orders'));
      expect(first.status).toBe(404);
      expect(await first.text()).toBe('gone fishing');
      expect((await post(receiver.urlFor('orders'))).status).toBe(200);
    });

    it('a scripted delayMs is honoured', async () => {
      receiver.setScenario('orders', { default: { status: 200, delayMs: 120 } });

      const started = Date.now();
      await post(receiver.urlFor('orders'));

      expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    });

    it('records each request with its headers and its body exactly as received', async () => {
      const body = '{ "spacing" :  "kept",\n"unicode":"ünï ✓" }';
      await post(receiver.urlFor('orders'), body, { 'webhook-id': 'evt_42' });

      const [recorded] = receiver.requests('orders');
      expect(recorded?.body).toBe(body);
      expect(recorded?.headers['webhook-id']).toBe('evt_42');
      expect(recorded?.headers['content-type']).toBe('application/json');
      expect(Number.isNaN(Date.parse(recorded?.receivedAt ?? ''))).toBe(false);
      expect(recorded).not.toHaveProperty('signatureValid');
    });

    it('keeps buckets apart', async () => {
      receiver.setScenario('a', { default: { status: 500 } });

      expect((await post(receiver.urlFor('a'))).status).toBe(500);
      expect((await post(receiver.urlFor('b'))).status).toBe(200);
      expect(receiver.requests('a')).toHaveLength(1);
      expect(receiver.requests('b')).toHaveLength(1);
      expect(receiver.requests('c')).toEqual([]);
    });

    it('setScenario clears the recorded requests, and deleteBucket removes scenario and record', async () => {
      await post(receiver.urlFor('orders'));
      receiver.setScenario('orders', { default: { status: 503 } });
      expect(receiver.requests('orders')).toEqual([]);

      await post(receiver.urlFor('orders'));
      receiver.deleteBucket('orders');

      expect(receiver.requests('orders')).toEqual([]);
      expect((await post(receiver.urlFor('orders'))).status).toBe(200);
    });

    it('verifySecret marks each recorded request with signatureValid', async () => {
      // A Standard Webhooks signature made by hand, so this test does not depend on @hdl/core.
      const key = Buffer.from('test-signing-key-of-32-bytes-ok!', 'utf8');
      const secret = `whsec_${key.toString('base64')}`;
      const body = '{"type":"order.created"}';
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', key)
        .update(`evt_1.${timestamp}.${body}`)
        .digest('base64');
      const headers = {
        'webhook-id': 'evt_1',
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1,${signature}`,
      };
      receiver.setScenario('orders', { verifySecret: secret });

      await post(receiver.urlFor('orders'), body, headers);
      await post(receiver.urlFor('orders'), `${body} `, headers); // body changed after signing
      await post(receiver.urlFor('orders'), body); // no webhook-* headers at all

      expect(receiver.requests('orders').map((request) => request.signatureValid)).toEqual([
        true,
        false,
        false,
      ]);
    });
  });

  describe('control API', () => {
    const control = (bucket: string, suffix = ''): string =>
      `${base()}/__control/buckets/${bucket}${suffix}`;

    it('PUT sets the scenario and clears the record; GET returns the requests, oldest first', async () => {
      await post(receiver.urlFor('orders'), '{"old":true}');

      const put = await fetch(control('orders'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ responses: [{ status: 500 }], default: { status: 200 } }),
      });
      expect(put.status).toBe(200);

      expect((await post(receiver.urlFor('orders'), '{"n":1}')).status).toBe(500);
      expect((await post(receiver.urlFor('orders'), '{"n":2}')).status).toBe(200);

      const response = await fetch(control('orders', '/requests'));
      const requests = (await response.json()) as RecordedRequest[];
      expect(response.status).toBe(200);
      expect(requests.map((request) => request.body)).toEqual(['{"n":1}', '{"n":2}']);
    });

    it('GET returns an empty list for a bucket that received nothing', async () => {
      const response = await fetch(control('untouched', '/requests'));
      expect(await response.json()).toEqual([]);
    });

    it('DELETE removes the scenario and the record', async () => {
      receiver.setScenario('orders', { default: { status: 503 } });
      await post(receiver.urlFor('orders'));

      const response = await fetch(control('orders'), { method: 'DELETE' });

      expect(response.status).toBe(204);
      expect(receiver.requests('orders')).toEqual([]);
      expect((await post(receiver.urlFor('orders'))).status).toBe(200);
    });

    it.each([
      ['not json', 'not json'],
      ['an array', '[]'],
      ['a status that is not a status code', '{"default":{"status":"503"}}'],
      ['a status out of range', '{"responses":[{"status":99}]}'],
      ['responses that is not a list', '{"responses":{"status":200}}'],
      ['a negative delay', '{"default":{"status":200,"delayMs":-1}}'],
      ['a verifySecret that is not a string', '{"verifySecret":123}'],
    ])('PUT with %s is refused with 400 and changes nothing', async (_label, body) => {
      receiver.setScenario('orders', { default: { status: 418 } });

      const response = await fetch(control('orders'), { method: 'PUT', body });

      expect(response.status).toBe(400);
      expect((await post(receiver.urlFor('orders'))).status).toBe(418);
    });
  });

  it('parseScenario keeps only the known fields', () => {
    expect(parseScenario({})).toEqual({});
    expect(
      parseScenario({ default: { status: 200 }, verifySecret: 'whsec_x', somethingElse: true }),
    ).toEqual({ default: { status: 200 }, verifySecret: 'whsec_x' });
  });
});
