// Types of the filter DSL. A Connection may carry a filter; during fan-out an event is delivered
// through the connection only if the filter matches. Pipeline position: fan-out (and, in the
// dashboard, the filter tester). Spec: docs/FILTER-RULES.md

/** The only values a filter can compare against. */
export type FilterPrimitive = string | number | boolean | null;

/** Operators applied to the value found at one path. Several operators on one path are ANDed. */
export interface ConditionObject {
  $eq?: FilterPrimitive;
  $neq?: FilterPrimitive;
  $in?: FilterPrimitive[];
  $nin?: FilterPrimitive[];
  $exists?: boolean;
  $gt?: number | string;
  $gte?: number | string;
  $lt?: number | string;
  $lte?: number | string;
  $contains?: FilterPrimitive;
  $startsWith?: string;
  $not?: ConditionObject;
}

/** A bare primitive is shorthand for `{ "$eq": primitive }`. */
export type Condition = FilterPrimitive | ConditionObject;

/**
 * One of `body`, `headers`, or `query`. A key is either a dot path such as "data.customer.id"
 * (its value is a Condition) or one of the logic keys `$and`, `$or`, `$not`.
 */
export interface Section {
  [pathOrLogicKey: string]: Condition | Section | Section[] | undefined;
}

export interface Filter {
  body?: Section;
  headers?: Section;
  query?: Section;
  $and?: Filter[];
  $or?: Filter[];
  $not?: Filter;
}

/** What a filter is evaluated against: the three parts of the stored request. */
export interface FilterInput {
  /** The parsed JSON body. `undefined` when the body is not valid JSON. */
  body: unknown;
  /** Header names lowercased. */
  headers: Record<string, string>;
  /** Repeated query keys become arrays. Values are always strings. */
  query: Record<string, string | string[]>;
}

/** One validation problem. Same shape as an entry of `error.details` in the API. */
export interface FilterIssue {
  /** Where in the filter, e.g. "body.data.amount.$in". Empty for the filter as a whole. */
  path: string;
  message: string;
}

export type ParseFilterResult = { ok: true; filter: Filter } | { ok: false; issues: FilterIssue[] };
