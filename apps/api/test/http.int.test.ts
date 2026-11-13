// Integration tests for the HTTP shell around the endpoints: probes, the error shape, request
// ids, CORS, and what the request log contains.
import type { ErrorResponse, Readiness } from '@hdl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  captureLogger,
  createTenant,
  createTestApp,
  eventually,
  signedRequest,
} from './helpers.js';
import type { TestApp, TestTenant } from './helpers.js';

describe('probes, errors, request ids and CORS', () => {
  const log = captureLogger();
  let t: TestApp;
  let tenant: TestTenant;

  beforeAll(async () => {
    t = await createTestApp({ CORS_ORIGINS: 'http://localhost:3000' }, { logger: log.logger });
    tenant = await createTenant(t.prisma, t.env);
  });

  afterAll(async () => {
    await tenant.remove();
    await t.close();
  });

  it('AC15.1 GET /health returns 200 {"status":"ok"}', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('AC15.2 GET /ready returns 200 when Postgres and Redis both answer', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json<Readiness>()).toEqual({
      status: 'ok',
      checks: { postgres: 'ok', redis: 'ok' },
    });
  });

  it('an unknown route returns 404 in the standard error shape', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/no/such/route' });

    expect(response.statusCode).toBe(404);
    const body = response.json<ErrorResponse>();
    expect(body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Not found.', requestId: expect.any(String) as string },
    });
    expect(response.headers['x-request-id']).toBe(body.error.requestId);
  });

  it('generates a request id and returns it as a header', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/health' });

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps a sane x-request-id from the caller, in the header and in the error body', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/in/no-such-source',
      headers: { 'content-type': 'application/json', 'x-request-id': 'trace-abc.123' },
      payload: '{}',
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['x-request-id']).toBe('trace-abc.123');
    expect(response.json<ErrorResponse>().error.requestId).toBe('trace-abc.123');
  });

  it.each(['has spaces in it', 'x'.repeat(65), 'new\nline', '<script>'])(
    'replaces an x-request-id that is not sane: %j',
    async (requestId) => {
      const response = await t.app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-request-id': requestId },
      });

      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('parser errors carry the request id too (they pass through the same filter)', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/in/whatever',
      headers: { 'content-type': 'application/json', 'x-request-id': 'parse-1' },
      payload: '{not json',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Request body is not valid JSON.',
      requestId: 'parse-1',
    });
  });

  it('answers a CORS preflight for an allowed origin with the explicit method list', async () => {
    const response = await t.app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'PATCH' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(response.headers['access-control-allow-methods']).toBe('GET, HEAD, POST, PATCH, DELETE');
  });

  it('does not allow an origin that is not in CORS_ORIGINS', async () => {
    const response = await t.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('logs the request with its ids, and never a header value, a secret or the body', async () => {
    const source = await tenant.addSource();
    const request = signedRequest(source, {
      body: '{"card":"4242-BODY-MARKER"}',
      headers: { 'x-request-id': 'log-test-1', authorization: 'Bearer LOGGEDTOKEN' },
    });

    const response = await t.app.inject(request);
    expect(response.statusCode).toBe(202);
    const eventId = response.json<{ id: string }>().id;

    const lines = log.lines().filter((line) => line.requestId === 'log-test-1');
    // Our own line for the accepted webhook, with the correlation ids of docs/adr/0015.
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: 'Webhook accepted', tenantId: tenant.id, eventId }),
    );
    // Fastify's own lines for the request: method and url, the status code, and no headers.
    const incoming = lines.find((line) => line.msg === 'incoming request');
    expect(incoming?.req).toMatchObject({ method: 'POST', url: `/in/${source.slug}` });
    expect(incoming?.req).not.toHaveProperty('headers');
    const completed = await eventually(() =>
      log.lines().find((l) => l.requestId === 'log-test-1' && l.msg === 'request completed'),
    );
    expect(completed.res).toEqual({ statusCode: 202 });

    const everything = log.raw();
    expect(everything).not.toContain(request.headers['webhook-signature']);
    expect(everything).not.toContain('LOGGEDTOKEN');
    expect(everything).not.toContain('4242-BODY-MARKER');
    expect(everything).not.toContain(source.secret);
  });
});
