// Integration tests for rate limiting through the HTTP endpoint (M4). The algorithm itself is
// tested in packages/core; here we check the 429, the Retry-After header, and where the
// limiter sits in the pipeline.
import type { ErrorResponse } from '@hdl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant, createTestApp, signedRequest } from './helpers.js';
import type { TestApp, TestTenant } from './helpers.js';

const WINDOW_MS = 60_000;

/**
 * These tests use the real clock. If a 60-second window ended in the middle of a test, the
 * counter would start again and the expected 429 might not come. So: when the current window
 * has less than three seconds left, wait for the next one. Almost always a no-op.
 */
async function avoidWindowBoundary(): Promise<void> {
  const remainingMs = WINDOW_MS - (Date.now() % WINDOW_MS);
  if (remainingMs < 3000) await new Promise((resolve) => setTimeout(resolve, remainingMs + 50));
}

describe('rate limiting on POST /in/:sourceSlug', () => {
  let t: TestApp;
  const tenants: TestTenant[] = [];

  /** A new tenant per test: rate-limit counters are per tenant, so each test starts at zero. */
  async function tenantWithLimit(ingestRateLimit: number) {
    const tenant = await createTenant(t.prisma, t.env, { ingestRateLimit });
    tenants.push(tenant);
    return { tenant, source: await tenant.addSource() };
  }

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    for (const tenant of tenants) await tenant.remove();
    await t.close();
  });

  it('AC4.1 SEC-RL-01 allows `limit` requests, then answers 429 with Retry-After', async () => {
    const { source } = await tenantWithLimit(5);
    await avoidWindowBoundary();

    for (let i = 0; i < 5; i += 1) {
      expect((await t.app.inject(signedRequest(source))).statusCode).toBe(202);
    }
    const rejected = await t.app.inject(signedRequest(source));

    expect(rejected.statusCode).toBe(429);
    const retryAfter = Number(rejected.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(rejected.json<ErrorResponse>().error).toMatchObject({
      code: 'RATE_LIMITED',
      message: `Rate limit exceeded. Retry after ${retryAfter} seconds.`,
    });
  });

  it('a rate-limited request stores no Event', async () => {
    const { source } = await tenantWithLimit(2);
    await avoidWindowBoundary();

    for (let i = 0; i < 6; i += 1) await t.app.inject(signedRequest(source));

    expect(await t.prisma.event.count({ where: { sourceId: source.id } })).toBe(2);
  });

  it('AC4.2 SEC-RL-02 50 concurrent requests against a limit of 10: exactly 10 are accepted', async () => {
    const { source } = await tenantWithLimit(10);
    await avoidWindowBoundary();

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => t.app.inject(signedRequest(source))),
    );

    expect(responses.filter((r) => r.statusCode === 202)).toHaveLength(10);
    expect(responses.filter((r) => r.statusCode === 429)).toHaveLength(40);
    expect(await t.prisma.event.count({ where: { sourceId: source.id } })).toBe(10);
  });

  it('AC4.4 SEC-RL-06 requests with an invalid signature do not use up the quota', async () => {
    const { source } = await tenantWithLimit(3);
    await avoidWindowBoundary();

    for (let i = 0; i < 20; i += 1) {
      const forged = await t.app.inject(
        signedRequest(source, { headers: { 'webhook-signature': 'v1,AAAA' } }),
      );
      expect(forged.statusCode).toBe(401);
    }

    // The whole limit is still there for genuine requests.
    for (let i = 0; i < 3; i += 1) {
      expect((await t.app.inject(signedRequest(source))).statusCode).toBe(202);
    }
    expect((await t.app.inject(signedRequest(source))).statusCode).toBe(429);
  });

  it('SEC-RL-04 one tenant at its limit does not affect another tenant', async () => {
    const limited = await tenantWithLimit(1);
    const other = await tenantWithLimit(1);
    await avoidWindowBoundary();

    expect((await t.app.inject(signedRequest(limited.source))).statusCode).toBe(202);
    expect((await t.app.inject(signedRequest(limited.source))).statusCode).toBe(429);
    expect((await t.app.inject(signedRequest(other.source))).statusCode).toBe(202);
  });
});
