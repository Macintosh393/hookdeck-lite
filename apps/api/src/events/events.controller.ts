// GET /api/v1/events and GET /api/v1/events/:eventId. HTTP only: validation in, JSON out.
// Contract: docs/api/openapi.yaml (listEvents, getEvent).
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { eventListQuerySchema } from '@hdl/shared';
import type { Event, EventDetail, Page } from '@hdl/shared';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { CurrentAuth } from '../auth/auth-context.js';
import type { AuthContext } from '../auth/auth-context.js';
import { parseOrThrow, requireUuid } from '../common/validation.js';
import { EventsService } from './events.service.js';

@Controller('api/v1/events')
@UseGuards(ApiKeyGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<Page<Event>> {
    return this.events.list(auth.tenant.id, parseOrThrow(eventListQuerySchema, query));
  }

  @Get(':eventId')
  get(@CurrentAuth() auth: AuthContext, @Param('eventId') eventId: string): Promise<EventDetail> {
    return this.events.get(auth.tenant.id, requireUuid(eventId));
  }
}
