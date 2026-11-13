// Integration tests for what happens when a dependency is down (the failure-mode table in
// docs/ARCHITECTURE.md). "Down" is simulated by building the app with a URL that points at a
// closed port: stopping the shared containers would break the test files running in parallel.
import type { ErrorResponse, IngestResponse, Readiness } from '@hdl/shared';
import { connect, createServer } from 'node:net';
import type { Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closedPort, createTenant, createTestApp, eventually, signedRequest } from './helpers.js';
import type { TestApp, TestSource, TestTenant } from './helpers.js';

describe('Redis is down', () => {
  let t: TestApp;
  let tenant: TestTenant;
  let source: TestSource;

  beforeAll(async () => {
    const redisUrl = `redis://127.0.0.1:${await closedPort()}/0`;
    // Postgres is the real one; only Redis is unreachable. Do not wait long for it at startup.
    t = await createTestApp({ REDIS_URL: redisUrl }, { redisReadyTimeoutMs: 100 });
    tenant = await createTenant(t.prisma, t.env, { ingestRateLimit: 2 });
    source = await tenant.addSource();
  });

  afterAll(async () => {
    await tenant.remove();
    await t.close();
  });

  it('AC1.3 the response is still 202, the Event is stored, and it is fast', async () => {
    // Warm the source cache, so the timing below measures the Redis failure path only.
    await t.app.inject(signedRequest(source));

    const startedAt = Date.now();
    const response = await t.app.inject(signedRequest(source));
    const elapsedMs = Date.now() - startedAt;

    expect(response.statusCode).toBe(202);
    const body = response.json<IngestResponse>();
    expect(body.status).toBe('accepted');
    const event = await t.prisma.event.findUniqueOrThrow({ where: { id: body.id } });
    // Still RECEIVED with no job: exactly the state the sweeper looks for (Day 2).
    expect(event.status).toBe('RECEIVED');
    // A hanging Redis call would take seconds. Failing fast takes milliseconds.
    expect(elapsedMs).toBeLessThan(500);
  });

  it('AC4.3 SEC-RL-05 the rate limiter fails open: requests over the limit are accepted', async () => {
    // The tenant's limit is 2. With the limiter's store down, all of these must pass.
    for (let i = 0; i < 5; i += 1) {
      expect((await t.app.inject(signedRequest(source))).statusCode).toBe(202);
    }
  });

  it('AC15.2 /ready returns 503 and names redis as the failed check', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json<Readiness>()).toEqual({
      status: 'unavailable',
      checks: { postgres: 'ok', redis: 'fail' },
    });
  });

  it('AC15.1 /health still returns 200', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('Postgres is down', () => {
  let t: TestApp;

  beforeAll(async () => {
    const databaseUrl = `postgresql://hookdeck:hookdeck@127.0.0.1:${await closedPort()}/hookdeck_test`;
    t = await createTestApp({ DATABASE_URL: databaseUrl });
  });

  afterAll(async () => {
    await t.close();
  });

  it('AC1.4 the response is 503 SERVICE_UNAVAILABLE and nothing is enqueued', async () => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/in/any-source',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":1}',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json<ErrorResponse>().error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Temporarily unable to accept events.',
    });
    expect(await t.fanoutQueue.getJobCountByTypes('waiting', 'delayed', 'active')).toBe(0);
  });

  it('AC15.2 /ready returns 503 and names postgres; AC15.1 /health returns 200', async () => {
    const ready = await t.app.inject({ method: 'GET', url: '/ready' });
    const health = await t.app.inject({ method: 'GET', url: '/health' });

    expect(ready.statusCode).toBe(503);
    expect(ready.json<Readiness>()).toEqual({
      status: 'unavailable',
      checks: { postgres: 'fail', redis: 'ok' },
    });
    expect(health.statusCode).toBe(200);
  });
});

describe('the Postgres insert fails', () => {
  let t: TestApp;
  let tenant: TestTenant;

  beforeAll(async () => {
    t = await createTestApp();
    tenant = await createTenant(t.prisma, t.env);
  });

  afterAll(async () => {
    await tenant.remove();
    await t.close();
  });

  it('AC1.4 an INSERT that Postgres refuses is a 503, and nothing is enqueued', async () => {
    // Cache the source, then delete its row. The lookup now succeeds from the cache and the
    // INSERT fails on the foreign key: a real database error at the insert step.
    const source = await tenant.addSource();
    expect((await t.app.inject(signedRequest(source))).statusCode).toBe(202);
    await t.prisma.source.delete({ where: { id: source.id } });
    const jobsBefore = await t.fanoutQueue.getJobCountByTypes('waiting', 'delayed', 'active');

    const response = await t.app.inject(signedRequest(source));

    expect(response.statusCode).toBe(503);
    expect(response.json<ErrorResponse>().error.code).toBe('SERVICE_UNAVAILABLE');
    expect(await t.fanoutQueue.getJobCountByTypes('waiting', 'delayed', 'active')).toBe(jobsBefore);
  });
});

describe('Redis is down when the api starts, and comes back later', () => {
  let t: TestApp;
  let tenant: TestTenant;
  let proxy: Server | undefined;

  afterAll(async () => {
    await tenant.remove();
    await t.close();
    proxy?.close();
  });

  it('enqueues again once Redis is reachable (the queue is created late, not broken forever)', async () => {
    // Start the api against a port where nothing listens...
    const port = await closedPort();
    const realRedis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379/1');
    t = await createTestApp(
      { REDIS_URL: `redis://127.0.0.1:${port}${realRedis.pathname}` },
      { redisReadyTimeoutMs: 100 },
    );
    tenant = await createTenant(t.prisma, t.env);
    const source = await tenant.addSource();
    expect((await t.app.inject(signedRequest(source))).statusCode).toBe(202);

    // ...then make Redis "come back" on that port: a tiny TCP proxy to the real Redis.
    proxy = createServer((client) => {
      const upstream = connect(Number(realRedis.port || 6379), realRedis.hostname);
      client.pipe(upstream).pipe(client);
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
    });
    await new Promise<void>((resolve) => proxy?.listen(port, '127.0.0.1', resolve));

    // ioredis reconnects by itself. From then on a webhook must get its fan-out job.
    const eventId = await eventually(
      async () => {
        const response = await t.app.inject(signedRequest(source));
        const { id } = response.json<IngestResponse>();
        try {
          return (await t.fanoutQueue.getJob(id)) ? id : undefined;
        } catch {
          return undefined; // the queue does not exist yet
        }
      },
      { timeoutMs: 15_000, intervalMs: 200 },
    );
    expect(eventId).toEqual(expect.any(String));
  });
});
