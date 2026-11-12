// Unit tests for the rate limiter's error handling: the NOSCRIPT fallback, fail open, and the
// timeout. The algorithm itself is tested against the real Redis in test/rate-limiter.int.test.ts.
//
// These tests pass a hand-written stand-in for the two Redis methods the limiter calls. The real
// way to provoke NOSCRIPT is `SCRIPT FLUSH`, and that would wipe BullMQ's scripts under the other
// test files that share the Redis.
import type { Redis } from 'ioredis';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createRateLimiter, rateLimitKey } from './limiter.js';
import { RATE_LIMIT_SCRIPT } from './script.js';

const logger = pino({ level: 'silent' });
const input = { tenantId: 'tenant-1', limit: 10, nowMs: 60_000 * 5 + 15_000 };

type ScriptCall = { method: 'evalsha' | 'eval'; args: unknown[] };

/** A stand-in Redis that records calls and answers with whatever the test supplies. */
function fakeRedis(handlers: { evalsha: () => Promise<unknown>; eval?: () => Promise<unknown> }): {
  redis: Redis;
  calls: ScriptCall[];
} {
  const calls: ScriptCall[] = [];
  const redis = {
    evalsha: (...args: unknown[]) => {
      calls.push({ method: 'evalsha', args });
      return handlers.evalsha();
    },
    eval: (...args: unknown[]) => {
      calls.push({ method: 'eval', args });
      return handlers.eval ? handlers.eval() : Promise.reject(new Error('eval not expected'));
    },
  };
  return { redis: redis as unknown as Redis, calls };
}

describe('createRateLimiter', () => {
  it('calls EVALSHA with the current and the previous window key', async () => {
    const { redis, calls } = fakeRedis({ evalsha: () => Promise.resolve([1, 0]) });

    const decision = await createRateLimiter({ redis, logger }).check(input);

    expect(decision).toEqual({ allowed: true, retryAfterMs: 0, failedOpen: false });
    expect(calls).toHaveLength(1);
    // sha, number of keys, current key, previous key, limit, window ms, elapsed ms
    expect(calls[0]?.args.slice(1)).toEqual([
      2,
      rateLimitKey('tenant-1', 5),
      rateLimitKey('tenant-1', 4),
      10,
      60_000,
      15_000,
    ]);
    expect(rateLimitKey('tenant-1', 5)).toBe('hdl:rl:tenant-1:5');
  });

  it('falls back to EVAL with the script source when Redis answers NOSCRIPT', async () => {
    const { redis, calls } = fakeRedis({
      evalsha: () => Promise.reject(new Error('NOSCRIPT No matching script. Please use EVAL.')),
      eval: () => Promise.resolve([0, 45_000]),
    });

    const decision = await createRateLimiter({ redis, logger }).check(input);

    expect(decision).toEqual({ allowed: false, retryAfterMs: 45_000, failedOpen: false });
    expect(calls.map((call) => call.method)).toEqual(['evalsha', 'eval']);
    expect(calls[1]?.args[0]).toBe(RATE_LIMIT_SCRIPT);
  });

  it('fails open on any other Redis error', async () => {
    const { redis, calls } = fakeRedis({
      evalsha: () => Promise.reject(new Error('Connection is closed.')),
    });

    const decision = await createRateLimiter({ redis, logger }).check(input);

    expect(decision).toEqual({ allowed: true, retryAfterMs: 0, failedOpen: true });
    expect(calls.map((call) => call.method)).toEqual(['evalsha']);
  });

  it('fails open when Redis does not answer within the timeout', async () => {
    const { redis } = fakeRedis({ evalsha: () => new Promise(() => {}) });

    const decision = await createRateLimiter({ redis, logger, timeoutMs: 20 }).check(input);

    expect(decision).toEqual({ allowed: true, retryAfterMs: 0, failedOpen: true });
  });

  it('fails open on a reply it does not understand', async () => {
    const { redis } = fakeRedis({ evalsha: () => Promise.resolve('OK') });

    const decision = await createRateLimiter({ redis, logger }).check(input);

    expect(decision.failedOpen).toBe(true);
  });
});
