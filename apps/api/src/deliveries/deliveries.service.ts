// Read queries for deliveries: the list (`status=DEAD` is the dead-letter view), one delivery
// with its attempts, and the attempts alone. Every query carries the caller's tenantId (AC12.2).
import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@hdl/database';
import type {
  Delivery,
  DeliveryAttempt,
  DeliveryDetail,
  DeliveryListQuery,
  Page,
} from '@hdl/shared';
import { decodeCursor, toPage } from '../common/pagination.js';
import { toDelivery, toDeliveryAttempt, toDeliveryDetail } from '../common/serializers.js';
import { notFound } from '../common/validation.js';
import { PRISMA } from '../tokens.js';

@Injectable()
export class DeliveriesService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(tenantId: string, query: DeliveryListQuery): Promise<Page<Delivery>> {
    const beforeId = decodeCursor(query.cursor);
    const rows = await this.prisma.delivery.findMany({
      where: {
        tenantId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.destinationId ? { destinationId: query.destinationId } : {}),
        ...(query.connectionId ? { connectionId: query.connectionId } : {}),
        ...(query.eventId ? { eventId: query.eventId } : {}),
        ...(beforeId ? { id: { lt: beforeId } } : {}),
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    return toPage(rows, query.limit, toDelivery);
  }

  async get(tenantId: string, deliveryId: string): Promise<DeliveryDetail> {
    const delivery = await this.prisma.delivery.findFirst({
      where: { id: deliveryId, tenantId },
      include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
    });
    if (delivery === null) throw notFound();
    return toDeliveryDetail(delivery);
  }

  /** Not paginated: a delivery has at most `maxAttempts` attempts. */
  async listAttempts(tenantId: string, deliveryId: string): Promise<{ data: DeliveryAttempt[] }> {
    // Looked up through the delivery first, so an unknown or foreign id is a 404, not an empty list.
    const delivery = await this.prisma.delivery.findFirst({
      where: { id: deliveryId, tenantId },
      select: { id: true },
    });
    if (delivery === null) throw notFound();

    const attempts = await this.prisma.deliveryAttempt.findMany({
      where: { deliveryId, tenantId },
      orderBy: { attemptNumber: 'asc' },
    });
    return { data: attempts.map(toDeliveryAttempt) };
  }
}
