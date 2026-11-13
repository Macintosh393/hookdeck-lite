// Integration tests for the read endpoints of events and deliveries against the real Postgres:
// lists with cursor pagination and filters, detail views, and the error shape (AC10.1, AC12.1,
// AC12.3 of docs/PRD.md). The contract is docs/api/openapi.yaml.
import type { Delivery as DeliveryRow } from '@hdl/database';
import type {
  Delivery,
  DeliveryAttempt,
  DeliveryDetail,
  ErrorResponse,
  Event,
  EventDetail,
  Page,
} from '@hdl/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant, createTestApp, SAMPLE_BODY } from './helpers.js';
import type { TestApiKey, TestApp, TestDestination, TestSource, TestTenant } from './helpers.js';

/** Newest first: the order every list endpoint promises. Ids are UUID v7, so id order is time order. */
const newestFirst = (ids: string[]): string[] => [...ids].sort().reverse();

describe('read endpoints for events and deliveries', () => {
  let t: TestApp;
  let tenant: TestTenant;
  let key: TestApiKey;
  let source: TestSource;
  let otherSource: TestSource;
  let destination: TestDestination;
  let otherDestination: TestDestination;

  beforeAll(async () => {
    t = await createTestApp();
    tenant = await createTenant(t.prisma, t.env);
    key = await tenant.addApiKey();
    source = await tenant.addSource();
    otherSource = await tenant.addSource();
    destination = await tenant.addDestination(source);
    otherDestination = await tenant.addDestination(source);
  });

  afterAll(async () => {
    await tenant.remove();
    await t.close();
  });

  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: key.headers });

  describe('GET /api/v1/events', () => {
    let eventIds: string[];

    beforeAll(async () => {
      const events = [];
      for (let index = 0; index < 7; index += 1) {
        events.push(
          await tenant.createEvent(source, {
            // One per hour, oldest first, so the time filters have something to cut.
            receivedAt: new Date(Date.UTC(2026, 0, 1, index)),
            status: index < 5 ? 'FANNED_OUT' : 'RECEIVED',
            externalEventId: `msg_${index}`,
          }),
        );
      }
      events.push(await tenant.createEvent(otherSource, { status: 'FAILED', failureReason: 'x' }));
      eventIds = events.map((event) => event.id);
    });

    it('AC12.1 returns the tenant’s events newest first, in the Event shape, without headers or body', async () => {
      const response = await get('/api/v1/events');

      expect(response.statusCode).toBe(200);
      const page = response.json<Page<Event>>();
      expect(page.data.map((event) => event.id)).toEqual(newestFirst(eventIds));
      expect(page.pagination).toEqual({ nextCursor: null, hasMore: false });

      const oldest = page.data.find((event) => event.externalEventId === 'msg_0');
      expect(oldest).toEqual({
        id: expect.any(String) as string,
        sourceId: source.id,
        status: 'FANNED_OUT',
        externalEventId: 'msg_0',
        contentType: 'application/json',
        bodyBytes: Buffer.byteLength(SAMPLE_BODY),
        deliveryCount: 0,
        filteredCount: 0,
        failureReason: null,
        receivedAt: '2026-01-01T00:00:00.000Z',
        fannedOutAt: null,
      });
    });

    it('AC12.1 pages through the list with limit and cursor: every event once, in order, no overlap', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const suffix: string = cursor === null ? '' : `&cursor=${cursor}`;
        const page: Page<Event> = (await get(`/api/v1/events?limit=3${suffix}`)).json();
        expect(page.data.length).toBeLessThanOrEqual(3);
        expect(page.pagination.hasMore).toBe(page.pagination.nextCursor !== null);
        seen.push(...page.data.map((event) => event.id));
        cursor = page.pagination.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);

      expect(pages).toBe(3); // 8 events in pages of 3
      expect(seen).toEqual(newestFirst(eventIds));
    });

    it('a page that ends exactly on the last row has no next cursor', async () => {
      const page = (await get('/api/v1/events?limit=8')).json<Page<Event>>();

      expect(page.data).toHaveLength(8);
      expect(page.pagination).toEqual({ nextCursor: null, hasMore: false });
    });

    it('filters by sourceId and by status', async () => {
      const bySource = (await get(`/api/v1/events?sourceId=${otherSource.id}`)).json<Page<Event>>();
      const byStatus = (await get('/api/v1/events?status=RECEIVED')).json<Page<Event>>();
      const both = (await get(`/api/v1/events?status=RECEIVED&sourceId=${otherSource.id}`)).json<
        Page<Event>
      >();

      expect(bySource.data.map((event) => event.id)).toEqual([eventIds[7]]);
      expect(bySource.data[0]).toMatchObject({ status: 'FAILED', failureReason: 'x' });
      expect(byStatus.data.map((event) => event.externalEventId).sort()).toEqual([
        'msg_5',
        'msg_6',
      ]);
      expect(both.data).toEqual([]);
    });

    it('filters by time: `from` is inclusive, `to` is exclusive', async () => {
      const from = encodeURIComponent('2026-01-01T02:00:00Z');
      const to = encodeURIComponent('2026-01-01T04:00:00Z');

      const page = (await get(`/api/v1/events?from=${from}&to=${to}`)).json<Page<Event>>();

      expect(page.data.map((event) => event.externalEventId).sort()).toEqual(['msg_2', 'msg_3']);
    });

    it('a filter keeps working across pages', async () => {
      const first = (await get('/api/v1/events?status=FANNED_OUT&limit=2')).json<Page<Event>>();
      const second = (
        await get(
          `/api/v1/events?status=FANNED_OUT&limit=2&cursor=${first.pagination.nextCursor ?? ''}`,
        )
      ).json<Page<Event>>();

      const ids = [...first.data, ...second.data].map((event) => event.id);
      expect(ids).toEqual(newestFirst(eventIds.slice(0, 5)).slice(0, 4));
      expect(second.pagination.hasMore).toBe(true);
    });

    it.each([
      ['limit=0', 'limit'],
      ['limit=101', 'limit'],
      ['limit=abc', 'limit'],
      ['status=DEAD', 'status'],
      ['sourceId=not-a-uuid', 'sourceId'],
      ['from=yesterday', 'from'],
      ['cursor=not-a-cursor', 'cursor'],
    ])('AC12.3 ?%s returns 400 VALIDATION_ERROR naming the field', async (queryString, field) => {
      const response = await get(`/api/v1/events?${queryString}`);

      expect(response.statusCode).toBe(400);
      const { error } = response.json<ErrorResponse>();
      expect(error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        requestId: response.headers['x-request-id'],
      });
      expect(error.details?.map((detail) => detail.path)).toEqual([field]);
    });
  });

  describe('GET /api/v1/events/:eventId', () => {
    it('AC12.1 returns the event with its stored request and its deliveries, without attempts', async () => {
      const event = await tenant.createEvent(source, {
        headers: { 'content-type': 'application/json', 'webhook-signature': '[redacted]' },
        query: { a: '1', b: ['x', 'y'] },
        status: 'FANNED_OUT',
        deliveryCount: 2,
        fannedOutAt: new Date('2026-02-01T00:00:01.000Z'),
      });
      const first = await tenant.createDelivery(event, destination, {
        status: 'SUCCEEDED',
        attemptCount: 1,
        lastStatusCode: 200,
        completedAt: new Date(),
      });
      const second = await tenant.createDelivery(event, otherDestination);
      await tenant.addAttempt(first, 1, { outcome: 'SUCCESS', statusCode: 200, errorCode: null });

      const response = await get(`/api/v1/events/${event.id}`);

      expect(response.statusCode).toBe(200);
      const detail = response.json<EventDetail>();
      expect(detail).toMatchObject({
        id: event.id,
        sourceId: source.id,
        status: 'FANNED_OUT',
        deliveryCount: 2,
        fannedOutAt: '2026-02-01T00:00:01.000Z',
        headers: { 'content-type': 'application/json', 'webhook-signature': '[redacted]' },
        query: { a: '1', b: ['x', 'y'] },
        // Byte for byte what was received: a string, not re-serialized JSON.
        body: SAMPLE_BODY,
      });
      expect(detail.deliveries.map((delivery) => delivery.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      const succeeded = detail.deliveries.find((delivery) => delivery.id === first.id);
      expect(succeeded).toMatchObject({
        eventId: event.id,
        connectionId: destination.connectionId,
        destinationId: destination.id,
        status: 'SUCCEEDED',
        trigger: 'EVENT',
        replayOfId: null,
        attemptCount: 1,
        lastStatusCode: 200,
      });
      expect(succeeded).not.toHaveProperty('attempts');
      // Internal columns stay internal.
      expect(detail).not.toHaveProperty('tenantId');
      expect(succeeded).not.toHaveProperty('tenantId');
    });

    it.each([
      ['an id that does not exist', '019a7b2e-6c1f-7a3b-9d4e-2f1a8c5b7e90'],
      ['an id that is not a UUID', 'not-a-uuid'],
    ])('AC12.3 %s returns 404 NOT_FOUND in the standard error shape', async (_label, id) => {
      const response = await get(`/api/v1/events/${id}`);

      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorResponse>()).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found.',
          requestId: response.headers['x-request-id'],
        },
      });
    });
  });

  describe('deliveries', () => {
    let dead: DeliveryRow;
    let succeeded: DeliveryRow;
    let retrying: DeliveryRow;
    let eventId: string;

    beforeAll(async () => {
      const event = await tenant.createEvent(source, { status: 'FANNED_OUT', deliveryCount: 3 });
      eventId = event.id;
      dead = await tenant.createDelivery(event, destination, {
        status: 'DEAD',
        deadReason: 'RETRIES_EXHAUSTED',
        attemptCount: 4,
        lastStatusCode: 503,
        lastErrorCode: 'HTTP_ERROR',
        lastAttemptAt: new Date('2026-03-01T00:00:04.000Z'),
        completedAt: new Date('2026-03-01T00:00:04.100Z'),
      });
      succeeded = await tenant.createDelivery(event, otherDestination, {
        status: 'SUCCEEDED',
        attemptCount: 1,
        lastStatusCode: 200,
        completedAt: new Date(),
      });
      retrying = await tenant.createDelivery(event, otherDestination, {
        status: 'RETRYING',
        attemptCount: 1,
        nextAttemptAt: new Date('2026-03-01T01:00:00.000Z'),
      });
      // Stored out of order on purpose: the API must sort by attempt number.
      for (const attemptNumber of [3, 1, 4, 2]) {
        await tenant.addAttempt(dead, attemptNumber, {
          startedAt: new Date(Date.UTC(2026, 2, 1, 0, 0, attemptNumber)),
          retryAfterMs: attemptNumber === 1 ? 20_000 : null,
        });
      }
    });

    it('AC10.1 GET /api/v1/deliveries?status=DEAD is the dead-letter view', async () => {
      const response = await get(`/api/v1/deliveries?status=DEAD&eventId=${eventId}`);

      expect(response.statusCode).toBe(200);
      const page = response.json<Page<Delivery>>();
      expect(page.data).toHaveLength(1);
      expect(page.data[0]).toEqual({
        id: dead.id,
        eventId,
        connectionId: destination.connectionId,
        destinationId: destination.id,
        status: 'DEAD',
        trigger: 'EVENT',
        replayOfId: null,
        attemptCount: 4,
        maxAttempts: t.env.DELIVERY_MAX_ATTEMPTS,
        nextAttemptAt: null,
        lastAttemptAt: '2026-03-01T00:00:04.000Z',
        lastStatusCode: 503,
        lastErrorCode: 'HTTP_ERROR',
        deadReason: 'RETRIES_EXHAUSTED',
        completedAt: '2026-03-01T00:00:04.100Z',
        createdAt: expect.any(String) as string,
      });
      expect(page.pagination).toEqual({ nextCursor: null, hasMore: false });
    });

    it('AC12.1 lists deliveries newest first and filters by destination, connection and event', async () => {
      const all = (await get(`/api/v1/deliveries?eventId=${eventId}`)).json<Page<Delivery>>();
      const byDestination = (
        await get(`/api/v1/deliveries?eventId=${eventId}&destinationId=${otherDestination.id}`)
      ).json<Page<Delivery>>();
      const byConnection = (
        await get(`/api/v1/deliveries?eventId=${eventId}&connectionId=${destination.connectionId}`)
      ).json<Page<Delivery>>();
      const retryingOnly = (
        await get(`/api/v1/deliveries?eventId=${eventId}&status=RETRYING`)
      ).json<Page<Delivery>>();

      expect(all.data.map((d) => d.id)).toEqual(newestFirst([dead.id, succeeded.id, retrying.id]));
      expect(byDestination.data.map((d) => d.id).sort()).toEqual(
        [succeeded.id, retrying.id].sort(),
      );
      expect(byConnection.data.map((d) => d.id)).toEqual([dead.id]);
      expect(retryingOnly.data).toHaveLength(1);
      expect(retryingOnly.data[0]).toMatchObject({
        id: retrying.id,
        nextAttemptAt: '2026-03-01T01:00:00.000Z',
        deadReason: null,
        completedAt: null,
      });
    });

    it('AC12.1 pages through deliveries with limit and cursor', async () => {
      const first = (await get(`/api/v1/deliveries?eventId=${eventId}&limit=2`)).json<
        Page<Delivery>
      >();
      const second = (
        await get(
          `/api/v1/deliveries?eventId=${eventId}&limit=2&cursor=${first.pagination.nextCursor ?? ''}`,
        )
      ).json<Page<Delivery>>();

      expect(first.pagination.hasMore).toBe(true);
      expect(second.pagination).toEqual({ nextCursor: null, hasMore: false });
      expect([...first.data, ...second.data].map((d) => d.id)).toEqual(
        newestFirst([dead.id, succeeded.id, retrying.id]),
      );
    });

    it.each([
      ['status=FANNED_OUT', 'status'],
      ['destinationId=1', 'destinationId'],
      ['limit=1000', 'limit'],
    ])('AC12.3 ?%s returns 400 VALIDATION_ERROR naming the field', async (queryString, field) => {
      const response = await get(`/api/v1/deliveries?${queryString}`);

      expect(response.statusCode).toBe(400);
      const { error } = response.json<ErrorResponse>();
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details?.map((detail) => detail.path)).toEqual([field]);
    });

    it('AC12.1 GET /api/v1/deliveries/:id returns the delivery with every attempt, oldest first', async () => {
      const response = await get(`/api/v1/deliveries/${dead.id}`);

      expect(response.statusCode).toBe(200);
      const detail = response.json<DeliveryDetail>();
      expect(detail).toMatchObject({ id: dead.id, status: 'DEAD', attemptCount: 4 });
      expect(detail.attempts.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3, 4]);
      expect(detail.attempts[0]).toEqual({
        id: expect.any(String) as string,
        deliveryId: dead.id,
        attemptNumber: 1,
        outcome: 'RETRYABLE_FAILURE',
        statusCode: 503,
        errorCode: 'HTTP_ERROR',
        errorMessage: 'Destination responded with 503.',
        startedAt: '2026-03-01T00:00:01.000Z',
        durationMs: 12,
        retryAfterMs: 20_000,
        resolvedIp: '127.0.0.1',
        requestHeaders: {
          'webhook-id': eventId,
          'webhook-signature': '[redacted]',
          'x-hdl-attempt': '1',
        },
        responseHeaders: { 'content-type': 'text/plain' },
        responseBody: 'Service Unavailable',
        responseBodyTruncated: false,
      });
    });

    it('a delivery without attempts has an empty list, and a transport error has no response fields', async () => {
      const event = await tenant.createEvent(source);
      const pending = await tenant.createDelivery(event, destination);
      const failed = await tenant.createDelivery(event, otherDestination, { status: 'RETRYING' });
      await tenant.addAttempt(failed, 1, {
        statusCode: null,
        errorCode: 'TIMEOUT',
        errorMessage: 'The request timed out',
        responseHeaders: undefined,
        responseBody: null,
      });

      const pendingDetail = (await get(`/api/v1/deliveries/${pending.id}`)).json<DeliveryDetail>();
      const failedDetail = (await get(`/api/v1/deliveries/${failed.id}`)).json<DeliveryDetail>();

      expect(pendingDetail.attempts).toEqual([]);
      expect(failedDetail.attempts[0]).toMatchObject({
        statusCode: null,
        errorCode: 'TIMEOUT',
        responseHeaders: null,
        responseBody: null,
      });
    });

    it('AC12.1 GET /api/v1/deliveries/:id/attempts returns { data } oldest first', async () => {
      const response = await get(`/api/v1/deliveries/${dead.id}/attempts`);

      expect(response.statusCode).toBe(200);
      const body = response.json<{ data: DeliveryAttempt[] }>();
      expect(Object.keys(body)).toEqual(['data']);
      expect(body.data.map((attempt) => attempt.attemptNumber)).toEqual([1, 2, 3, 4]);
      expect(body.data.every((attempt) => attempt.deliveryId === dead.id)).toBe(true);
    });

    it.each(['/api/v1/deliveries/{id}', '/api/v1/deliveries/{id}/attempts'])(
      'AC12.3 %s returns 404 for an unknown id and for an id that is not a UUID',
      async (template) => {
        for (const id of ['019a7b2e-6c1f-7a3b-9d4e-2f1a8c5b7e90', 'nope']) {
          const response = await get(template.replace('{id}', id));
          expect(response.statusCode).toBe(404);
          expect(response.json<ErrorResponse>().error.code).toBe('NOT_FOUND');
        }
      },
    );
  });
});
