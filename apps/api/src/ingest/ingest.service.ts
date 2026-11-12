// The ingestion pipeline: source lookup -> verify -> rate limit -> insert -> enqueue -> publish.
// This file is sequence diagram 1 of docs/ARCHITECTURE.md, step for step. The order is the
// design: Postgres is written before Redis, so a 202 always means "stored" (docs/adr/0004).
import { Inject, Injectable } from '@nestjs/common';
import { publishStreamMessage, verifyInboundSignature, withTimeout } from '@hdl/core';
import type { Env, Logger, RateLimiter, Redis } from '@hdl/core';
import { isUniqueViolation } from '@hdl/database';
import type { PrismaClient } from '@hdl/database';
import type { IngestResponse } from '@hdl/shared';
import { ApiError } from '../common/api-error.js';
import { FanoutProducer } from '../infrastructure/fanout-producer.js';
import { ENV, LOGGER, PRISMA, RATE_LIMITER, REDIS } from '../tokens.js';
import { SourceCache } from './source-cache.js';
import type { CachedSource } from './source-cache.js';
import {
  readExternalEventId,
  sensitiveHeaderNames,
  toStoredHeaders,
  toStoredQuery,
} from './stored-request.js';

/** Upper bound for one Redis call on the request path, for a Redis that is up but not answering. */
const REDIS_CALL_TIMEOUT_MS = 1000;

export interface IngestInput {
  sourceSlug: string;
  /** The exact bytes of the request body. */
  rawBody: Buffer;
  /** The same bytes decoded as UTF-8 (the controller has checked that they are valid UTF-8). */
  bodyText: string;
  contentType: string;
  headers: Record<string, string | string[] | undefined>;
  query: unknown;
  requestId: string;
}

const serviceUnavailable = (): ApiError =>
  new ApiError(503, 'SERVICE_UNAVAILABLE', 'Temporarily unable to accept events.');

@Injectable()
export class IngestService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly rootLogger: Logger,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(RATE_LIMITER) private readonly rateLimiter: RateLimiter,
    private readonly sourceCache: SourceCache,
    private readonly fanoutProducer: FanoutProducer,
  ) {}

  async ingest(input: IngestInput): Promise<IngestResponse> {
    const nowMs = Date.now();

    // 1. Which source is this, and whose is it? (Postgres unreachable: the cache throws a 503.)
    const source = await this.sourceCache.get(input.sourceSlug);
    // A disabled source answers exactly like an unknown one.
    if (source === null || !source.enabled)
      throw new ApiError(404, 'NOT_FOUND', 'Source not found.');

    // One child logger per request: every line below carries these ids (docs/adr/0015).
    const log = this.rootLogger.child({
      requestId: input.requestId,
      tenantId: source.tenantId,
      sourceId: source.id,
    });

    // 2. Is the request really from the provider?
    const verification = verifyInboundSignature({
      config: source.config,
      secret: source.secret,
      headers: input.headers,
      rawBody: input.rawBody,
      toleranceSeconds: this.env.SIGNATURE_TOLERANCE_SECONDS,
      nowMs,
    });
    if (!verification.ok) {
      // The reason goes to the log only. Telling a caller which step failed helps an attacker.
      log.info({ reason: verification.reason }, 'Webhook rejected: signature verification failed');
      throw new ApiError(401, 'INVALID_SIGNATURE', 'Signature verification failed.');
    }

    // 3. Is the tenant within its rate limit? After verification, so that forged requests
    //    cannot use up a tenant's quota (AC4.4). Fails open if Redis is down.
    const decision = await this.rateLimiter.check({
      tenantId: source.tenantId,
      limit: source.ingestRateLimit,
      nowMs,
    });
    if (!decision.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      log.info({ retryAfterSeconds }, 'Webhook rejected: rate limit exceeded');
      throw new ApiError(
        429,
        'RATE_LIMITED',
        `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`,
        { 'retry-after': String(retryAfterSeconds) },
      );
    }

    // 4. Store the event. This INSERT is the commit point: after it, the event cannot be lost.
    const externalEventId = readExternalEventId(input.headers, source.dedupeHeader);
    const stored = await this.insertEvent(source, input, externalEventId, log);
    if (stored.duplicate) {
      log.info({ eventId: stored.id }, 'Duplicate webhook: returning the event stored first');
      return { id: stored.id, status: 'duplicate' };
    }
    const eventId = stored.id;

    // 5. Ask the worker to fan the event out. Best effort: if Redis is down the event stays
    //    RECEIVED in Postgres and the sweeper enqueues it later (sequence diagram 6).
    try {
      await withTimeout(
        this.fanoutProducer.enqueue({ eventId, tenantId: source.tenantId }),
        REDIS_CALL_TIMEOUT_MS,
        'fanout enqueue',
      );
    } catch (error) {
      log.warn(
        { eventId, err: error instanceof Error ? error.message : String(error) },
        'Could not enqueue the fan-out job; the sweeper will pick the event up',
      );
    }

    // 6. Tell the live stream. Also best effort; publishStreamMessage never throws.
    await withTimeout(
      publishStreamMessage(this.redis, log, source.tenantId, {
        type: 'event.received',
        at: new Date(nowMs).toISOString(),
        data: { eventId, sourceId: source.id },
      }),
      REDIS_CALL_TIMEOUT_MS,
      'stream publish',
    ).catch(() => false);

    log.info({ eventId, bodyBytes: input.rawBody.length }, 'Webhook accepted');
    return { id: eventId, status: 'accepted' };
  }

  /**
   * Step 4. Returns the new event's id, or the id of the event stored first when the unique
   * index on (sourceId, externalEventId) refuses this one. Deduplication is done by the
   * database, not by a SELECT-then-INSERT, so two concurrent copies cannot both get in.
   */
  private async insertEvent(
    source: CachedSource,
    input: IngestInput,
    externalEventId: string | null,
    log: Logger,
  ): Promise<{ id: string; duplicate: boolean }> {
    try {
      const event = await this.prisma.event.create({
        data: {
          tenantId: source.tenantId,
          sourceId: source.id,
          externalEventId,
          contentType: input.contentType,
          headers: toStoredHeaders(input.headers, sensitiveHeaderNames(source.config)),
          query: toStoredQuery(input.query),
          body: input.bodyText,
          bodyBytes: input.rawBody.length,
        },
        select: { id: true },
      });
      return { id: event.id, duplicate: false };
    } catch (error) {
      if (externalEventId !== null && isUniqueViolation(error)) {
        const first = await this.findFirstEvent(source.id, externalEventId);
        if (first) return { id: first.id, duplicate: true };
      }
      log.error({ err: error }, 'Could not store the event');
      throw serviceUnavailable();
    }
  }

  private async findFirstEvent(
    sourceId: string,
    externalEventId: string,
  ): Promise<{ id: string } | null> {
    try {
      return await this.prisma.event.findUnique({
        where: { sourceId_externalEventId: { sourceId, externalEventId } },
        select: { id: true },
      });
    } catch {
      return null;
    }
  }
}
