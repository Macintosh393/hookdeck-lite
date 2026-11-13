// Integration tests for API-key auth and tenant isolation on the management API: AC13.1–AC13.3,
// AC12.2 (docs/PRD.md) and SEC-AUTH-01 to SEC-AUTH-04, SEC-ENC-06, SEC-ENC-07, SEC-LIM-04
// (docs/SECURITY.md#security-test-checklist), for the endpoints that exist on Day 2.
// The stream (SEC-AUTH-04, SEC-AUTH-05 over HTTP) and the CRUD endpoints arrive on Day 3.
import { hashApiKey } from '@hdl/core';
import type { ErrorResponse, Whoami } from '@hdl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  captureLogger,
  createTenant,
  createTestApp,
  eventually,
  signedRequest,
} from './helpers.js';
import type { TestApiKey, TestApp, TestDestination, TestSource, TestTenant } from './helpers.js';

describe('API-key auth and tenant isolation', () => {
  const log = captureLogger();
  let t: TestApp;
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let keyA: TestApiKey;
  let keyB: TestApiKey;
  let sourceB: TestSource;
  let destinationB: TestDestination;

  beforeAll(async () => {
    t = await createTestApp({}, { logger: log.logger });
    tenantA = await createTenant(t.prisma, t.env);
    tenantB = await createTenant(t.prisma, t.env);
    keyA = await tenantA.addApiKey({ name: 'Key of A' });
    keyB = await tenantB.addApiKey();
    sourceB = await tenantB.addSource();
    destinationB = await tenantB.addDestination(sourceB);
  });

  afterAll(async () => {
    await tenantA.remove();
    await tenantB.remove();
    await t.close();
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url, headers });

  describe('M13: API-key auth', () => {
    it('GET /api/v1/whoami returns the tenant and the key behind the request', async () => {
      const response = await get('/api/v1/whoami', keyA.headers);

      expect(response.statusCode).toBe(200);
      const tenant = await t.prisma.tenant.findUniqueOrThrow({ where: { id: tenantA.id } });
      expect(response.json<Whoami>()).toEqual({
        tenant: { id: tenantA.id, name: tenant.name, ingestRateLimit: tenant.ingestRateLimit },
        apiKey: { prefix: keyA.prefix, name: 'Key of A' },
      });
    });

    it('AC13.1 SEC-AUTH-01 no header, a malformed header, an unknown key and a revoked key all get the same 401 body', async () => {
      const revoked = await tenantA.addApiKey({ revoked: true });
      // Right prefix, wrong secret: the row is found, the hash does not match.
      const wrongSecret = `hdl_${keyA.prefix}_${'x'.repeat(32)}`;
      const cases: Array<Record<string, string>> = [
        {},
        { authorization: '' },
        { authorization: keyA.key }, // no "Bearer"
        { authorization: `Basic ${keyA.key}` },
        { authorization: 'Bearer not-an-api-key' },
        { authorization: `Bearer ${keyA.key}extra` },
        { authorization: `Bearer hdl_${'z'.repeat(8)}_${'z'.repeat(32)}` }, // unknown prefix
        { authorization: `Bearer ${wrongSecret}` },
        revoked.headers,
      ];

      const bodies = new Set<string>();
      for (const headers of cases) {
        const response = await get('/api/v1/whoami', headers);
        expect(response.statusCode).toBe(401);
        const body = response.json<ErrorResponse>();
        expect(body.error.requestId).toBe(response.headers['x-request-id']);
        // The request id differs per request; everything else must be identical.
        bodies.add(JSON.stringify({ ...body.error, requestId: null }));
      }
      expect([...bodies]).toEqual([
        JSON.stringify({
          code: 'UNAUTHORIZED',
          message: 'A valid API key is required.',
          requestId: null,
        }),
      ]);
    });

    it('AC13.3 a key stops working the moment it is revoked', async () => {
      const key = await tenantA.addApiKey();
      expect((await get('/api/v1/whoami', key.headers)).statusCode).toBe(200);

      await t.prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });

      expect((await get('/api/v1/whoami', key.headers)).statusCode).toBe(401);
    });

    it('SEC-AUTH-04 every /api/v1 route built so far answers 401 without a key and runs no handler', async () => {
      const id = '019a7b2e-6c1f-7a3b-9d4e-2f1a8c5b7e90';
      const routes: Array<['GET' | 'POST', string]> = [
        ['GET', '/api/v1/whoami'],
        ['GET', '/api/v1/events'],
        ['GET', `/api/v1/events/${id}`],
        ['GET', '/api/v1/deliveries'],
        ['GET', `/api/v1/deliveries/${id}`],
        ['GET', `/api/v1/deliveries/${id}/attempts`],
        ['POST', `/api/v1/deliveries/${id}/replay`],
        ['POST', `/api/v1/destinations/${destinationB.id}/replay-dead`],
      ];

      for (const [method, url] of routes) {
        const response = await t.app.inject({ method, url });
        expect(response.statusCode, `${method} ${url}`).toBe(401);
        expect(response.json<ErrorResponse>().error.code).toBe('UNAUTHORIZED');
      }
      // The guard ran before any handler: the replay-dead call created nothing.
      expect(await t.prisma.delivery.count({ where: { tenantId: tenantB.id } })).toBe(0);
    });

    it('/in, /health and /ready need no API key', async () => {
      expect((await get('/health')).statusCode).toBe(200);
      expect((await get('/ready')).statusCode).toBe(200);
      expect((await t.app.inject(signedRequest(sourceB))).statusCode).toBe(202);
    });

    it('records lastUsedAt, at most once a minute', async () => {
      const key = await tenantA.addApiKey();
      await get('/api/v1/whoami', key.headers);

      const first = await eventually(async () => {
        const row = await t.prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
        return row.lastUsedAt;
      });
      expect(Date.now() - first.getTime()).toBeLessThan(10_000);

      await get('/api/v1/whoami', key.headers);
      await get('/api/v1/whoami', key.headers);
      // Give a second write the chance to happen, then see that it did not.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const row = await t.prisma.apiKey.findUniqueOrThrow({ where: { id: key.id } });
      expect(row.lastUsedAt).toEqual(first);
    });
  });

  describe('what is stored and what is returned', () => {
    it('AC13.2 SEC-AUTH-03 the database stores only the prefix and a SHA-256 hash; the plaintext key is in no table', async () => {
      const row = await t.prisma.apiKey.findUniqueOrThrow({ where: { id: keyA.id } });
      expect(row.keyHash).toBe(hashApiKey(keyA.key));
      expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);

      // Every row of every table that belongs to tenant A, as text.
      const secretPart = keyA.key.split('_')[2] ?? '';
      expect(secretPart).toHaveLength(32);
      const dump = await dumpTenant(tenantA.id);
      expect(dump).toContain(keyA.prefix); // the dump does include the key's row
      expect(dump).not.toContain(keyA.key);
      expect(dump).not.toContain(secretPart);
    });

    it('SEC-ENC-06 no column contains the plaintext secret of a source or a destination (rows written the way the seed does; the create endpoints are Day 3)', async () => {
      expect(sourceB.secret).toMatch(/^whsec_/);
      const dump = await dumpTenant(tenantB.id);

      expect(dump).toContain(sourceB.slug);
      expect(dump).toContain('"v1:k1:'); // the AES-256-GCM envelope is what is stored
      for (const secret of [sourceB.secret ?? '', destinationB.signingSecret]) {
        expect(dump).not.toContain(secret);
        expect(dump).not.toContain(secret.replace('whsec_', ''));
      }
    });

    it('SEC-ENC-07 AC12.4 no list or get endpoint built so far returns a secret, a hash or an encrypted column', async () => {
      const event = await tenantB.createEvent(sourceB, {
        headers: { 'content-type': 'application/json', 'webhook-signature': '[redacted]' },
      });
      const delivery = await tenantB.createDelivery(event, destinationB, { status: 'RETRYING' });
      await tenantB.addAttempt(delivery, 1);
      const urls = [
        '/api/v1/whoami',
        '/api/v1/events',
        `/api/v1/events/${event.id}`,
        '/api/v1/deliveries',
        `/api/v1/deliveries/${delivery.id}`,
        `/api/v1/deliveries/${delivery.id}/attempts`,
      ];

      for (const url of urls) {
        const response = await get(url, keyB.headers);
        expect(response.statusCode, url).toBe(200);
        const text = response.body;
        for (const forbidden of [
          sourceB.secret ?? '',
          destinationB.signingSecret,
          keyB.key,
          hashApiKey(keyB.key),
          'secretEnc',
          'signingSecretEnc',
          'keyHash',
          'v1:k1:',
        ]) {
          expect(text, `${url} must not contain ${forbidden}`).not.toContain(forbidden);
        }
      }
    });

    it('SEC-LIM-04 the api’s logs of an ingest and of management requests contain no secret, API key, signature or payload', async () => {
      const body = '{"type":"order.created","card":"4242-secret-payload-marker"}';
      const request = signedRequest(sourceB, { body });
      const ingest = await t.app.inject(request);
      expect(ingest.statusCode).toBe(202);
      const { id: eventId } = ingest.json<{ id: string }>();
      await get(`/api/v1/events/${eventId}`, keyB.headers);
      await get('/api/v1/whoami', { authorization: 'Bearer hdl_wrongkey_but-logged-nowhere' });

      const raw = log.raw();
      // The requests were logged at all: otherwise the checks below would pass on an empty log.
      expect(raw).toContain(`/in/${sourceB.slug}`);
      expect(raw).toContain(`/api/v1/events/${eventId}`);
      const signature = request.headers['webhook-signature'] ?? '';
      expect(signature).toMatch(/^v1,/);
      for (const forbidden of [
        sourceB.secret ?? '',
        (sourceB.secret ?? '').replace('whsec_', ''),
        signature,
        signature.replace('v1,', ''),
        keyB.key,
        keyB.key.split('_')[2] ?? '',
        'but-logged-nowhere',
        '4242-secret-payload-marker',
        t.env.SECRETS_MASTER_KEY,
      ]) {
        expect(forbidden.length).toBeGreaterThan(8);
        expect(raw).not.toContain(forbidden);
      }
    });
  });

  describe('M12: tenant isolation', () => {
    it('AC12.2 SEC-AUTH-02 tenant A’s key cannot read or replay tenant B’s resources: 404, exactly like an id that does not exist', async () => {
      const event = await tenantB.createEvent(sourceB);
      const delivery = await tenantB.createDelivery(event, destinationB, {
        status: 'DEAD',
        deadReason: 'RETRIES_EXHAUSTED',
        completedAt: new Date(),
      });
      await tenantB.addAttempt(delivery, 1);
      const requests: Array<['GET' | 'POST', string]> = [
        ['GET', `/api/v1/events/${event.id}`],
        ['GET', `/api/v1/deliveries/${delivery.id}`],
        ['GET', `/api/v1/deliveries/${delivery.id}/attempts`],
        ['POST', `/api/v1/deliveries/${delivery.id}/replay`],
        ['POST', `/api/v1/destinations/${destinationB.id}/replay-dead`],
      ];
      const deliveriesBefore = await t.prisma.delivery.count({ where: { tenantId: tenantB.id } });

      for (const [method, url] of requests) {
        const asA = await t.app.inject({ method, url, headers: keyA.headers });
        expect(asA.statusCode, `${method} ${url} as tenant A`).toBe(404);
        expect(asA.json<ErrorResponse>().error).toMatchObject({
          code: 'NOT_FOUND',
          message: 'Resource not found.',
        });
      }
      // Nothing was replayed on B's behalf.
      expect(await t.prisma.delivery.count({ where: { tenantId: tenantB.id } })).toBe(
        deliveriesBefore,
      );

      // The owner gets them.
      expect((await get(`/api/v1/events/${event.id}`, keyB.headers)).statusCode).toBe(200);
      expect((await get(`/api/v1/deliveries/${delivery.id}`, keyB.headers)).statusCode).toBe(200);
    });

    it('AC12.2 lists only contain the caller’s rows, and another tenant’s id as a filter matches nothing', async () => {
      const event = await tenantB.createEvent(sourceB);
      await tenantB.createDelivery(event, destinationB);

      const eventsOfA = await get('/api/v1/events', keyA.headers);
      const deliveriesOfA = await get('/api/v1/deliveries', keyA.headers);
      const filtered = await get(`/api/v1/events?sourceId=${sourceB.id}`, keyA.headers);
      const byEvent = await get(`/api/v1/deliveries?eventId=${event.id}`, keyA.headers);

      for (const response of [eventsOfA, deliveriesOfA, filtered, byEvent]) {
        expect(response.statusCode).toBe(200);
        expect(response.json<{ data: unknown[] }>().data).toEqual([]);
      }
      const eventsOfB = await get('/api/v1/events', keyB.headers);
      expect(eventsOfB.json<{ data: Array<{ id: string }> }>().data.map((e) => e.id)).toContain(
        event.id,
      );
    });
  });

  /** Every row the tenant owns, in every table, serialized: what a database dump would show. */
  async function dumpTenant(tenantId: string): Promise<string> {
    const [tenant, apiKeys, sources, destinations, connections, events, deliveries, attempts] =
      await Promise.all([
        t.prisma.tenant.findMany({ where: { id: tenantId } }),
        t.prisma.apiKey.findMany({ where: { tenantId } }),
        t.prisma.source.findMany({ where: { tenantId } }),
        t.prisma.destination.findMany({ where: { tenantId } }),
        t.prisma.connection.findMany({ where: { tenantId } }),
        t.prisma.event.findMany({ where: { tenantId } }),
        t.prisma.delivery.findMany({ where: { tenantId } }),
        t.prisma.deliveryAttempt.findMany({ where: { tenantId } }),
      ]);
    return JSON.stringify({
      tenant,
      apiKeys,
      sources,
      destinations,
      connections,
      events,
      deliveries,
      attempts,
    });
  }
});
