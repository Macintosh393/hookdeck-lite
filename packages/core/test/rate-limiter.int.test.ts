// Integration tests for the rate limiter against the real Redis: the Lua script only means
// something when Redis runs it. Covers AC4.1–AC4.3 and SEC-RL-01 to 05 at the library level;
// the HTTP side (429, Retry-After, AC4.4) is tested in apps/api.
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRateLimiter,
  rateLimitKey,
  RATE_LIMIT_WINDOW_MS,
} from '../src/rate-limit/limiter.js';
import { createApiProducerConnection, waitForRedisReady } from '../src/redis.js';
import { captureLogger, closedPortRedisUrl, redisUrl } from './helpers.js';

const WINDOW = RATE_LIMIT_WINDOW_MS;
/** The start of some window, so each test controls exactly how far into a window "now" is. */
const WINDOW_START = Math.floor(Date.now() / WINDOW) * WINDOW;

describe('rate limiter (real Redis)', () => {
  const { logger } = captureLogger();
  let redis: Redis;
  /** Every tenant id used, so afterAll can delete the keys. */
  const tenants: string[] = [];

  /** Rate-limit keys are per tenant, so a fresh tenant id gives each test a clean counter. */
  function newTenant(): string {
    const tenantId = randomUUID();
    tenants.push(tenantId);
    return tenantId;
  }

  beforeAll(async () => {
    redis = createApiProducerConnection(redisUrl, logger);
    expect(await waitForRedisReady(redis, 5000)).toBe(true);
  });

  afterAll(async () => {
    const windowIndex = Math.floor(WINDOW_START / WINDOW);
    const keys = tenants.flatMap((tenantId) =>
      [-1, 0, 1, 2].map((offset) => rateLimitKey(tenantId, windowIndex + offset)),
    );
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it('AC4.1 SEC-RL-01 allows `limit` requests, then rejects with the time left in the window', async () => {
    const limiter = createRateLimiter({ redis, logger });
    const tenantId = newTenant();
    const nowMs = WINDOW_START + 10_000;

    for (let i = 0; i < 5; i += 1) {
      const decision = await limiter.check({ tenantId, limit: 5, nowMs });
      expect(decision).toEqual({ allowed: true, retryAfterMs: 0, failedOpen: false });
    }

    const rejected = await limiter.check({ tenantId, limit: 5, nowMs });
    expect(rejected).toEqual({ allowed: false, retryAfterMs: WINDOW - 10_000, failedOpen: false });
  });

  it('rejected requests are not counted, so hammering does not extend the lockout', async () => {
    const limiter = createRateLimiter({ redis, logger });
    const tenantId = newTenant();
    const nowMs = WINDOW_START + 1000;

    for (let i = 0; i < 20; i += 1) await limiter.check({ tenantId, limit: 3, nowMs });

    const stored = await redis.get(rateLimitKey(tenantId, Math.floor(nowMs / WINDOW)));
    expect(stored).toBe('3');
  });

  it('AC4.2 SEC-RL-02 lets exactly 10 of 50 concurrent requests through a limit of 10', async () => {
    const limiter = createRateLimiter({ redis, logger });
    const tenantId = newTenant();
    const nowMs = WINDOW_START + 5000;

    const decisions = await Promise.all(
      Array.from({ length: 50 }, () => limiter.check({ tenantId, limit: 10, nowMs })),
    );

    expect(decisions.filter((d) => d.allowed)).toHaveLength(10);
    expect(decisions.filter((d) => !d.allowed)).toHaveLength(40);
    expect(decisions.some((d) => d.failedOpen)).toBe(false);
  });

  it('SEC-RL-03 slides: halfway through the next window, half the limit is available', async () => {
    const limiter = createRateLimiter({ redis, logger });
    const tenantId = newTenant();
    const limit = 10;

    // Fill the first window completely.
    for (let i = 0; i < limit; i += 1) {
      await limiter.check({ tenantId, limit, nowMs: WINDOW_START + 1000 });
    }

    // At the very start of the next window the previous one still counts in full.
    const atStart = await limiter.check({ tenantId, limit, nowMs: WINDOW_START + WINDOW });
    expect(atStart.allowed).toBe(false);

    // Halfway through, the previous window weighs 0.5: 10 * 0.5 = 5 slots are taken, 5 are free.
    const halfway = WINDOW_START + WINDOW + WINDOW / 2;
    let allowed = 0;
    for (let i = 0; i < limit; i += 1) {
      const decision = await limiter.check({ tenantId, limit, nowMs: halfway });
      if (decision.allowed) allowed += 1;
    }
    expect(allowed).toBe(5);
  });

  it('a fixed-window boundary burst is not possible', async () => {
    const limiter = createRateLimiter({ redis, logger });
    const tenantId = newTenant();
    const limit = 10;

    // Use the whole limit in the last second of a window...
    for (let i = 0; i < limit; i += 1) {
      await limiter.check({ tenantId, limit, nowMs: WINDOW_START + WINDOW - 1000 });
    }
    // ...then try again one second into the next. A fixed window would allow 10 more.
    let allowed = 0;
    for (let i = 0; i < limit; i += 1) {
      const decision = await limiter.check({
        tenantId,
        limit,
        nowMs: WINDOW_START + WINDOW + 1000,
      });
      if (decision.allowed) allowed += 1;
    }
    expect(allowed).toBeLessThanOrEqual(1);
  });

  it('SEC-RL-04 keeps tenants apart: one tenant at its limit does not affect another', async () => {
    const limiter = createRateLimiter({ redis, logger });
    const tenantA = newTenant();
    const tenantB = newTenant();
    const nowMs = WINDOW_START + 2000;

    for (let i = 0; i < 3; i += 1) await limiter.check({ tenantId: tenantA, limit: 3, nowMs });

    expect((await limiter.check({ tenantId: tenantA, limit: 3, nowMs })).allowed).toBe(false);
    expect((await limiter.check({ tenantId: tenantB, limit: 3, nowMs })).allowed).toBe(true);
  });

  it('sets an expiry on the counter, so idle tenants leave nothing behind', async () => {
    const limiter = createRateLimiter({ redis, logger });
    const tenantId = newTenant();
    const nowMs = WINDOW_START + 3000;

    await limiter.check({ tenantId, limit: 3, nowMs });

    const ttlMs = await redis.pttl(rateLimitKey(tenantId, Math.floor(nowMs / WINDOW)));
    expect(ttlMs).toBeGreaterThan(WINDOW);
    expect(ttlMs).toBeLessThanOrEqual(WINDOW * 2);
  });
});

describe('rate limiter when Redis is unreachable', () => {
  it('AC4.3 SEC-RL-05 fails open quickly and logs a warning', async () => {
    const { logger, lines } = captureLogger();
    const redis = createApiProducerConnection(await closedPortRedisUrl(), logger);
    const limiter = createRateLimiter({ redis, logger });

    const startedAt = Date.now();
    const decision = await limiter.check({ tenantId: 'tenant-x', limit: 1, nowMs: Date.now() });
    const elapsedMs = Date.now() - startedAt;

    expect(decision).toEqual({ allowed: true, retryAfterMs: 0, failedOpen: true });
    expect(elapsedMs).toBeLessThan(1000);
    // Level 40 is pino's "warn".
    const warning = lines().find((line) => String(line.msg).includes('fail open'));
    expect(warning).toMatchObject({ level: 40, tenantId: 'tenant-x' });

    redis.disconnect();
  });
});
