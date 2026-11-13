// Replay: sending an event to a destination again after a delivery ended. A replay is a NEW
// Delivery row (trigger REPLAY, replayOfId = the original) with its own job and attempts; the
// original and its attempts are never modified. Pipeline position: api -> delivery queue.
// Spec: docs/adr/0007-dead-letter-and-replay.md, sequence diagram 4 of docs/ARCHITECTURE.md.
import { Inject, Injectable } from '@nestjs/common';
import { publishStreamMessage, withTimeout } from '@hdl/core';
import type { Env, Logger, Redis } from '@hdl/core';
import type { Delivery as DeliveryRow, PrismaClient } from '@hdl/database';
import type { BulkReplayResponse, Delivery } from '@hdl/shared';
import { ApiError } from '../common/api-error.js';
import { toDelivery } from '../common/serializers.js';
import { notFound } from '../common/validation.js';
import { DeliveryProducer } from '../infrastructure/delivery-producer.js';
import { ENV, LOGGER, PRISMA, REDIS } from '../tokens.js';

/** Deliveries replayed by one bulk call (docs/SECURITY.md#input-limits). The caller repeats while `hasMore`. */
export const BULK_REPLAY_LIMIT = 1000;

/** Upper bound for the Redis calls of one replay, for a Redis that is up but not answering. */
const REDIS_CALL_TIMEOUT_MS = 1000;
/** The same for a bulk replay, which adds up to 1000 jobs in one call. */
const BULK_REDIS_CALL_TIMEOUT_MS = 5000;

const conflict = (message: string): ApiError => new ApiError(409, 'CONFLICT', message);
const destinationDisabled = (): ApiError =>
  conflict('Destination is disabled. Enable it before replaying.');

@Injectable()
export class ReplayService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGGER) private readonly rootLogger: Logger,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly deliveryProducer: DeliveryProducer,
  ) {}

  /** POST /api/v1/deliveries/:id/replay */
  async replayDelivery(tenantId: string, deliveryId: string, requestId: string): Promise<Delivery> {
    const original = await this.prisma.delivery.findFirst({
      where: { id: deliveryId, tenantId },
      include: { destination: { select: { enabled: true } } },
    });
    if (original === null) throw notFound();
    // A delivery that is still PENDING or RETRYING will be attempted anyway. Replaying it
    // would send the event twice for no reason (AC10.4).
    if (original.status !== 'DEAD' && original.status !== 'SUCCEEDED') {
      throw conflict('Only DEAD or SUCCEEDED deliveries can be replayed.');
    }
    // The worker would mark the replay DEAD without an attempt; say so now instead.
    if (!original.destination.enabled) throw destinationDisabled();

    // The replay copies where the event goes, not how the original ended: a fresh attempt
    // counter, and the destination's current URL and secret when the worker sends it.
    const replay = await this.prisma.delivery.create({
      data: {
        tenantId,
        eventId: original.eventId,
        connectionId: original.connectionId,
        destinationId: original.destinationId,
        status: 'PENDING',
        trigger: 'REPLAY',
        replayOfId: original.id,
        maxAttempts: this.env.DELIVERY_MAX_ATTEMPTS,
      },
    });

    const log = this.rootLogger.child({
      requestId,
      tenantId,
      eventId: replay.eventId,
      deliveryId: replay.id,
    });
    await this.enqueueAndAnnounce(tenantId, [replay], REDIS_CALL_TIMEOUT_MS, log);
    log.info({ replayOfId: original.id }, 'Replay created');
    return toDelivery(replay);
  }

  /** POST /api/v1/destinations/:id/replay-dead */
  async replayDeadForDestination(
    tenantId: string,
    destinationId: string,
    requestId: string,
  ): Promise<BulkReplayResponse> {
    const { replays, hasMore } = await this.prisma.$transaction(async (tx) => {
      // FOR UPDATE locks the destination row until this transaction commits. A second bulk
      // replay of the same destination waits here, and when it gets the lock it sees the
      // replays created below and skips their originals. Without the lock, two quick clicks
      // on "replay all" would both read the same DEAD rows and send everything twice.
      const [destination] = await tx.$queryRaw<Array<{ enabled: boolean }>>`
        SELECT "enabled" FROM "Destination"
        WHERE "id" = ${destinationId}::uuid AND "tenantId" = ${tenantId}::uuid
        FOR UPDATE`;
      if (destination === undefined) throw notFound();
      if (!destination.enabled) throw destinationDisabled();

      // DEAD deliveries that nobody has replayed yet, oldest first. One row more than the
      // limit tells us whether another call is needed.
      const dead = await tx.delivery.findMany({
        where: { tenantId, destinationId, status: 'DEAD', replays: { none: {} } },
        select: { id: true, eventId: true, connectionId: true },
        orderBy: { id: 'asc' },
        take: BULK_REPLAY_LIMIT + 1,
      });
      const batch = dead.slice(0, BULK_REPLAY_LIMIT);
      if (batch.length === 0) return { replays: [], hasMore: false };

      const created = await tx.delivery.createManyAndReturn({
        data: batch.map((original) => ({
          tenantId,
          eventId: original.eventId,
          connectionId: original.connectionId,
          destinationId,
          status: 'PENDING' as const,
          trigger: 'REPLAY' as const,
          replayOfId: original.id,
          maxAttempts: this.env.DELIVERY_MAX_ATTEMPTS,
        })),
      });
      return { replays: created, hasMore: dead.length > BULK_REPLAY_LIMIT };
    });

    const log = this.rootLogger.child({ requestId, tenantId, destinationId });
    await this.enqueueAndAnnounce(tenantId, replays, BULK_REDIS_CALL_TIMEOUT_MS, log);
    log.info({ replayedCount: replays.length, hasMore }, 'Bulk replay created');
    return { replayedCount: replays.length, hasMore };
  }

  /**
   * The Redis half of a replay, after the rows are committed. Both steps are best effort, as
   * at ingestion: if Redis is down the Deliveries stay PENDING in Postgres and the sweeper
   * enqueues them (docs/QUEUES.md#sweeper), and the dashboard refetches over REST.
   */
  private async enqueueAndAnnounce(
    tenantId: string,
    replays: DeliveryRow[],
    timeoutMs: number,
    log: Logger,
  ): Promise<void> {
    if (replays.length === 0) return;
    try {
      // jobId = Delivery.id, so the sweeper adding the same job later is harmless.
      await withTimeout(
        this.deliveryProducer.enqueue(
          replays.map((replay) => ({
            data: { deliveryId: replay.id, eventId: replay.eventId, tenantId },
            maxAttempts: replay.maxAttempts,
          })),
        ),
        timeoutMs,
        'delivery enqueue',
      );
    } catch (error) {
      log.warn(
        { count: replays.length, err: error instanceof Error ? error.message : String(error) },
        'Could not enqueue the replay; the sweeper will pick the deliveries up',
      );
    }

    const at = new Date().toISOString();
    await withTimeout(
      Promise.all(
        replays.map((replay) =>
          publishStreamMessage(this.redis, log, tenantId, {
            type: 'delivery.created',
            at,
            data: {
              deliveryId: replay.id,
              eventId: replay.eventId,
              destinationId: replay.destinationId,
              trigger: 'REPLAY',
              replayOfId: replay.replayOfId,
            },
          }),
        ),
      ),
      timeoutMs,
      'stream publish',
    ).catch(() => undefined);
  }
}
