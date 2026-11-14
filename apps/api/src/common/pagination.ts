// Cursor pagination for the list endpoints: newest first, `?limit=50&cursor=<opaque>`.
// Spec: docs/DATA-MODEL.md#cursor-pagination
import type { Page } from '@hdl/shared';
import { ApiError } from './api-error.js';
import { isUuid } from './validation.js';

// LEARN: cursor pagination. Ids are UUID v7, which start with a timestamp, so `ORDER BY id DESC`
// is "newest first" and "the next page" is simply `WHERE id < <last id of this page>`. Unlike
// OFFSET, that costs the same on page 1 and page 500, and rows inserted meanwhile do not shift
// the pages. See docs/DATA-MODEL.md#cursor-pagination

/** The cursor is the last row's id, base64url-encoded so clients treat it as opaque. */
export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

/** The id inside a cursor, or undefined for the first page. A cursor we did not issue is a 400. */
export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  // Decoding never throws: it skips characters that are not base64. So check the result.
  if (!isUuid(id) || encodeCursor(id) !== cursor) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed.', {}, [
      { path: 'cursor', message: 'Invalid cursor' },
    ]);
  }
  return id;
}

/**
 * Turns `limit + 1` rows into a page of `limit`. The extra row is never returned: its only job
 * is to say whether another page exists, which saves a COUNT query.
 */
export function toPage<Row extends { id: string }, Item>(
  rows: Row[],
  limit: number,
  toItem: (row: Row) => Item,
): Page<Item> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    data: pageRows.map(toItem),
    pagination: { nextCursor: hasMore && last ? encodeCursor(last.id) : null, hasMore },
  };
}
