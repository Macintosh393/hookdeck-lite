// Tests for the minimal mock receiver. They use real sockets on a free port, because the
// receiver's whole job is to be a real HTTP endpoint.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockReceiver } from './index.js';
import type { MockReceiver } from './index.js';

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

  const post = (url: string, body = '{"hello":"world"}', headers: Record<string, string> = {}) =>
    fetch(url, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json', ...headers },
    });

  it('listens on a free port and builds bucket URLs from it', () => {
    expect(receiver.port).toBeGreaterThan(0);
    expect(receiver.urlFor('orders')).toBe(`http://127.0.0.1:${receiver.port}/hook/orders`);
  });

  it('answers POST /hook/:bucket with 200 {"ok":true}', async () => {
    const response = await post(receiver.urlFor('orders'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('answers with the status given in ?status=', async () => {
    const response = await post(`${receiver.urlFor('orders')}?status=503`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
  });

  it.each(['abc', '99', '700', '2000', ''])('ignores an invalid ?status=%s', async (status) => {
    const response = await post(`${receiver.urlFor('orders')}?status=${status}`);
    expect(response.status).toBe(200);
  });

  it('answers GET /health with 200', async () => {
    const response = await fetch(`http://127.0.0.1:${receiver.port}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('rejects other paths and methods', async () => {
    const base = `http://127.0.0.1:${receiver.port}`;

    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/hook/orders`)).status).toBe(405);
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
});
