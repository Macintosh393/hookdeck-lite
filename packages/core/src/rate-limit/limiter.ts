// The Node side of the rate limiter: builds the keys, runs the Lua script, and fails open.
// Pipeline position: ingest, after signature verification and before the Postgres insert.
// Spec: docs/SECURITY.md#rate-limiting
import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { withTimeout } from '../util/with-timeout.js';
import { RATE_LIMIT_SCRIPT } from './script.js';

/** The limit is "requests per 60-second sliding window". */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** EVALSHA identifies a script by the SHA-1 of its source. */
const SCRIPT_SHA = crypto.createHash('sha1').update(RATE_LIMIT_SCRIPT).digest('hex');

export interface RateLimitDecision {
  allowed: boolean;
  /** When rejected: milliseconds until the current window ends. An upper bound on the wait. */
  retryAfterMs: number;
  /** True when Redis could not answer and the request was let through unchecked. */
  failedOpen: boolean;
}

export interface RateLimitInput {
  tenantId: string;
  /** Tenant.ingestRateLimit: requests allowed per window. */
  limit: number;
  /** The current time, passed in so the window arithmetic uses one clock reading (and tests can pick it). */
  nowMs: number;
}

export interface RateLimiterOptions {
  redis: Redis;
  logger: Logger;
  windowMs?: number;
  /** How long to wait for Redis before letting the request through. */
  timeoutMs?: number;
}

export interface RateLimiter {
  check(input: RateLimitInput): Promise<RateLimitDecision>;
}

/** Key of one fixed window of one tenant. Canonical name: docs/ARCHITECTURE.md#canonical-names */
export function rateLimitKey(tenantId: string, windowIndex: number): string {
  return `hdl:rl:${tenantId}:${windowIndex}`;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { redis, logger } = options;
  const windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const timeoutMs = options.timeoutMs ?? 500;

  /** Runs the script and returns its reply: [allowed (1 or 0), ms until the window ends]. */
  async function runScript(input: RateLimitInput): Promise<unknown> {
    const windowIndex = Math.floor(input.nowMs / windowMs);
    const elapsedMs = input.nowMs % windowMs;
    const keys = [
      rateLimitKey(input.tenantId, windowIndex),
      rateLimitKey(input.tenantId, windowIndex - 1),
    ];
    const args = [input.limit, windowMs, elapsedMs];

    try {
      // EVALSHA sends 40 characters instead of the whole script on every request.
      return await redis.evalsha(SCRIPT_SHA, keys.length, ...keys, ...args);
    } catch (error) {
      // NOSCRIPT: this Redis has not seen the script yet (first call, or Redis restarted).
      // EVAL sends the source, and Redis caches it, so the next EVALSHA succeeds.
      if (error instanceof Error && error.message.startsWith('NOSCRIPT')) {
        return await redis.eval(RATE_LIMIT_SCRIPT, keys.length, ...keys, ...args);
      }
      throw error;
    }
  }

  return {
    async check(input: RateLimitInput): Promise<RateLimitDecision> {
      try {
        const reply = await withTimeout(runScript(input), timeoutMs, 'rate limit check');
        if (!Array.isArray(reply)) throw new Error('Unexpected reply from the rate-limit script');
        return {
          allowed: Number(reply[0]) === 1,
          retryAfterMs: Number(reply[1]),
          failedOpen: false,
        };
      } catch (error) {
        // Fail open: the limiter protects capacity, it is not a security boundary. Rejecting
        // real webhooks because the limiter's store is down would lose tenants' events.
        logger.warn(
          { tenantId: input.tenantId, err: error instanceof Error ? error.message : String(error) },
          'Rate limiter unavailable; allowing the request (fail open)',
        );
        return { allowed: true, retryAfterMs: 0, failedOpen: true };
      }
    },
  };
}
