// Unit tests for cursor pagination and the input helpers of the management API:
// round trips, malformed cursors, the "one extra row" page, and path ids (docs/TESTING.md#unit).
import { listQuerySchema } from '@hdl/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from './api-error.js';
import { decodeCursor, encodeCursor, toPage } from './pagination.js';
import { isUuid, parseOrThrow, requireUuid } from './validation.js';

const ID = '019a7b2e-6c1f-7a3b-9d4e-2f1a8c5b7e90';

/** Runs `fn` and returns the ApiError it throws. */
function apiErrorOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('Expected an ApiError');
}

describe('cursor encode/decode', () => {
  it('round-trips an id', () => {
    expect(decodeCursor(encodeCursor(ID))).toBe(ID);
  });

  it('produces the cursor shown in the OpenAPI example: base64url of the id', () => {
    expect(encodeCursor(ID)).toBe('MDE5YTdiMmUtNmMxZi03YTNiLTlkNGUtMmYxYThjNWI3ZTkw');
    expect(encodeCursor(ID)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns undefined for the first page (no cursor)', () => {
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it.each([
    ['not base64 at all', '!!!'],
    ['base64 of something that is not an id', Buffer.from('hello').toString('base64url')],
    ['a raw id, not encoded', ID],
    ['a valid cursor with extra characters', `${encodeCursor(ID)}!!`],
    ['a SQL fragment', Buffer.from("' OR 1=1 --").toString('base64url')],
  ])('rejects %s with 400 VALIDATION_ERROR on the cursor field', (_label, cursor) => {
    const error = apiErrorOf(() => decodeCursor(cursor));

    expect(error).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(error.details).toEqual([{ path: 'cursor', message: 'Invalid cursor' }]);
  });
});

describe('toPage', () => {
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `019a7b2e-0000-7000-8000-${String(100 - index).padStart(12, '0')}`,
    }));
  const idOf = (row: { id: string }) => row.id;

  it('returns everything and no cursor when the rows fit in the limit', () => {
    const page = toPage(rows(3), 3, idOf);

    expect(page.data).toHaveLength(3);
    expect(page.pagination).toEqual({ nextCursor: null, hasMore: false });
  });

  it('drops the extra row and points the cursor at the last row that was returned', () => {
    const fetched = rows(4); // limit 3, one extra

    const page = toPage(fetched, 3, idOf);

    expect(page.data).toEqual(fetched.slice(0, 3).map(idOf));
    expect(page.pagination.hasMore).toBe(true);
    expect(decodeCursor(page.pagination.nextCursor ?? undefined)).toBe(fetched[2]?.id);
  });

  it('handles an empty result', () => {
    expect(toPage([], 50, idOf)).toEqual({
      data: [],
      pagination: { nextCursor: null, hasMore: false },
    });
  });
});

describe('path ids', () => {
  it('accepts UUIDs in either case and returns them lowercased', () => {
    expect(isUuid(ID)).toBe(true);
    expect(requireUuid(ID.toUpperCase())).toBe(ID);
  });

  it.each(['', '123', 'not-a-uuid', `${ID}x`, `${ID} `, "'; DROP TABLE"])(
    'treats %j as an unknown resource: 404 NOT_FOUND',
    (value) => {
      expect(isUuid(value)).toBe(false);
      expect(apiErrorOf(() => requireUuid(value))).toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
      });
    },
  );
});

describe('parseOrThrow', () => {
  it('returns the parsed value with defaults applied', () => {
    expect(parseOrThrow(listQuerySchema, { limit: '10' })).toEqual({ limit: 10 });
    expect(parseOrThrow(listQuerySchema, {})).toEqual({ limit: 50 });
  });

  it('AC12.3 throws 400 VALIDATION_ERROR with the failing field in details', () => {
    const error = apiErrorOf(() => parseOrThrow(listQuerySchema, { limit: '1000' }));

    expect(error).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
    });
    expect(error.details?.map((detail) => detail.path)).toEqual(['limit']);
  });
});
