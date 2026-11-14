// Read queries for events: the list (without payloads) and one event with its stored request
// and its deliveries. Every query carries the caller's tenantId (AC12.2).
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@hdl/database';
import type { Event, EventDetail, EventListQuery, Page } from '@hdl/shared';
import { decodeCursor, toPage } from '../common/pagination.js';
import { EVENT_SUMMARY_SELECT, toEvent, toEventDetail } from '../common/serializers.js';
import { notFound } from '../common/validation.js';
import { PRISMA } from '../tokens.js';

@Injectable()
export class EventsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(tenantId: string, query: EventListQuery): Promise<Page<Event>> {
    const beforeId = decodeCursor(query.cursor);
    const receivedAt = {
      ...(query.from ? { gte: new Date(query.from) } : {}),
      ...(query.to ? { lt: new Date(query.to) } : {}),
    };

    const rows = await this.prisma.event.findMany({
      where: {
        tenantId,
        ...(query.sourceId ? { sourceId: query.sourceId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.from || query.to ? { receivedAt } : {}),
        // The cursor: only rows older than the last one of the previous page.
        ...(beforeId ? { id: { lt: beforeId } } : {}),
      },
      // The list leaves out headers, query and body: they can be a megabyte per event.
      select: EVENT_SUMMARY_SELECT,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, toEvent);
  }

  async get(tenantId: string, eventId: string): Promise<EventDetail> {
    // findFirst with both conditions: another tenant's event is "not found", never "forbidden",
    // so an id cannot be probed for existence.
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, tenantId },
      include: { deliveries: { orderBy: { id: 'asc' } } },
    });
    if (event === null) throw notFound();
    return toEventDetail(event);
  }
}
