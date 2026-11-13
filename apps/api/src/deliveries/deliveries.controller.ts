// The delivery endpoints of the management API: list, detail, attempts, and the two replays.
// HTTP only: validation in, JSON out. Contract: docs/api/openapi.yaml (tag Deliveries).
import { Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { deliveryListQuerySchema } from '@hdl/shared';
import type {
  BulkReplayResponse,
  Delivery,
  DeliveryAttempt,
  DeliveryDetail,
  Page,
} from '@hdl/shared';
import type { FastifyRequest } from 'fastify';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { CurrentAuth } from '../auth/auth-context.js';
import type { AuthContext } from '../auth/auth-context.js';
import { parseOrThrow, requireUuid } from '../common/validation.js';
import { DeliveriesService } from './deliveries.service.js';
import { ReplayService } from './replay.service.js';

@Controller('api/v1')
@UseGuards(ApiKeyGuard)
export class DeliveriesController {
  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly replay: ReplayService,
  ) {}

  @Get('deliveries')
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<Page<Delivery>> {
    return this.deliveries.list(auth.tenant.id, parseOrThrow(deliveryListQuerySchema, query));
  }

  @Get('deliveries/:deliveryId')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('deliveryId') deliveryId: string,
  ): Promise<DeliveryDetail> {
    return this.deliveries.get(auth.tenant.id, requireUuid(deliveryId));
  }

  @Get('deliveries/:deliveryId/attempts')
  listAttempts(
    @CurrentAuth() auth: AuthContext,
    @Param('deliveryId') deliveryId: string,
  ): Promise<{ data: DeliveryAttempt[] }> {
    return this.deliveries.listAttempts(auth.tenant.id, requireUuid(deliveryId));
  }

  // 202 Accepted, not 201: the new delivery exists, but the sending happens later, in the worker.
  @Post('deliveries/:deliveryId/replay')
  @HttpCode(202)
  replayDelivery(
    @CurrentAuth() auth: AuthContext,
    @Param('deliveryId') deliveryId: string,
    @Req() request: FastifyRequest,
  ): Promise<Delivery> {
    return this.replay.replayDelivery(auth.tenant.id, requireUuid(deliveryId), request.id);
  }

  // Lives here and not with the destination CRUD (Day 3) because it creates deliveries.
  @Post('destinations/:destinationId/replay-dead')
  @HttpCode(202)
  replayDead(
    @CurrentAuth() auth: AuthContext,
    @Param('destinationId') destinationId: string,
    @Req() request: FastifyRequest,
  ): Promise<BulkReplayResponse> {
    return this.replay.replayDeadForDestination(
      auth.tenant.id,
      requireUuid(destinationId),
      request.id,
    );
  }
}
