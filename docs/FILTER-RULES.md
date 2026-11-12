# Filter rules

A Connection may carry a filter. During fan-out, an event is delivered through the connection only if
the filter matches. The filter is a small JSON document, validated by Zod and evaluated by a pure function
in `packages/shared`, so the worker and the dashboard run the same code.
Decision: [ADR-0012](adr/0012-filter-rules-dsl.md).

```ts
// packages/shared/src/filter
export function parseFilter(input: unknown): { ok: true; filter: Filter } | { ok: false; issues: FilterIssue[] };
export function evaluateFilter(filter: Filter | null, input: FilterInput): boolean;

export interface FilterInput {
  body: unknown;                                  // the parsed JSON body
  headers: Record<string, string>;                // lowercased names
  query: Record<string, string | string[]>;       // repeated keys become arrays
}
```

`evaluateFilter` never throws, performs no I/O, and has no side effects.

## Shape

A filter has up to three **sections** and optional top-level logic:

```json
{
  "body":    { "type": "order.created", "data.amount": { "$gte": 100 } },
  "headers": { "x-environment": "production" },
  "query":   { "source": { "$in": ["web", "ios"] } }
}
```

Everything at one level is combined with AND. The example means: body `type` equals `"order.created"`
AND body `data.amount` ≥ 100 AND header `x-environment` equals `"production"` AND query `source` is one of the two values.

## Grammar

```
Filter      := { "body"?: Section, "headers"?: Section, "query"?: Section,
                 "$and"?: Filter[], "$or"?: Filter[], "$not"?: Filter }

Section     := { (Path: Condition)*,
                 "$and"?: Section[], "$or"?: Section[], "$not"?: Section }

Path        := dot-separated segments, e.g. "data.customer.id" or "items.0.sku"

Condition   := Primitive                      -- shorthand for { "$eq": Primitive }
             | { Operator: Operand, ... }      -- several operators on one path are ANDed

Primitive   := string | number | boolean | null

Operator    := "$eq" | "$neq" | "$in" | "$nin" | "$exists"
             | "$gt" | "$gte" | "$lt" | "$lte"
             | "$contains" | "$startsWith" | "$not"
```

| Operator | Operand | True when |
|---|---|---|
| `$eq` | Primitive | value is strictly equal to the operand |
| `$neq` | Primitive | not `$eq` |
| `$in` | Primitive[] (1–50 items) | value is strictly equal to any item |
| `$nin` | Primitive[] (1–50 items) | not `$in` |
| `$exists` | boolean | the path is present (`true`) or absent (`false`) |
| `$gt`, `$gte`, `$lt`, `$lte` | number or string | value and operand are both numbers, or both strings, and the comparison holds |
| `$contains` | Primitive | value is a string containing the operand (a string); or value is an array with an item strictly equal to the operand |
| `$startsWith` | string | value is a string that starts with the operand |
| `$not` (inside a Condition) | Condition object | the nested condition is false |
| `$and` | array (1–10 items) | every item matches |
| `$or` | array (1–10 items) | at least one item matches |
| `$not` (Section or Filter level) | Section or Filter | the nested one does not match |

Zod shape, in outline: `Filter` and `Section` are recursive `z.lazy` strict objects; `Section` uses
`z.record` for path keys with a refinement that separates path keys from `$and`/`$or`/`$not`; `Condition`
is `z.union([primitive, z.strictObject({...operators}).refine(nonEmpty)])`. Unknown `$` keys are rejected.

## Evaluation semantics

### Path resolution

- A path is split on `.`. Each segment selects an own property of an object, or, if the current value is
  an array and the segment is a non-negative integer, that index.
- If any step fails (property absent, index out of range, current value not an object or array), the
  path is **missing**.
- A property whose value is `null` is **present** with value `null`. Missing and `null` are different.
- Keys that themselves contain a dot cannot be addressed. This is a known limitation.
- Header names are lowercased before evaluation; write header paths in lowercase. A header that appears
  several times is joined with `", "`.
- Query values are strings. A repeated key is an array of strings. Numbers in the query are strings:
  `{"page": 2}` does not match `?page=2`; `{"page": "2"}` does.
- If the body is not valid JSON, `body` is `undefined` and every body path is missing.

### Missing paths

| Operator | Result when the path is missing |
|---|---|
| `$eq`, `$in`, `$gt`, `$gte`, `$lt`, `$lte`, `$contains`, `$startsWith` | `false` |
| `$neq`, `$nin` | `true` |
| `$exists: true` | `false` |
| `$exists: false` | `true` |
| `$not: { ... }` | negation of the nested result under these same rules |

So `{ "status": { "$neq": "draft" } }` matches an event that has no `status` at all. To require presence,
add `"$exists": true` to the same condition.

### Types

- **No coercion.** `"5"` does not equal `5`. `true` does not equal `"true"`. `null` equals only `null`.
- `$eq`, `$neq`, `$in`, `$nin` compare primitives with `===`. If the value at the path is an object or
  an array, `$eq` and `$in` are `false` (and so `$neq` and `$nin` are `true`).
- Ordering operators: number vs number is numeric; string vs string compares by UTF-16 code units, which
  orders ISO-8601 timestamps of the same format correctly. Any other pairing (number vs string, boolean,
  null, object, array) is `false`. `NaN` never compares true.
- `$contains` on a string needs a string operand; on an array it checks items with `===`. On anything else it is `false`.
- `$startsWith` on a non-string is `false`.
- String comparisons are case-sensitive.
- There is no implicit array traversal. `"items.sku"` does not search inside the array; `"items.0.sku"` reads the first item.

### Combination

- A `null` filter, `{}`, and a section `{}` all match everything.
- Keys at the same level are ANDed, including `$and`, `$or`, and `$not` when they appear beside paths.
- Evaluation short-circuits, but since it has no side effects this is only an optimisation.
- If a stored filter fails validation at evaluation time (it should not), the result is `false` and the
  worker logs an error with the connection id. Failing closed avoids delivering events to a destination
  that asked not to receive them.

## Limits

Enforced by `parseFilter` when a connection is created or updated (`400 VALIDATION_ERROR` on violation).

| Limit | Value | Why |
|---|---|---|
| Serialized size | 4096 bytes | Bounds storage and parse time |
| Nesting depth of `$and` / `$or` / `$not` | 5 | Bounds recursion |
| Total conditions (operator applications) | 50 | Bounds work per event |
| Items in `$and` / `$or` | 10 | |
| Items in `$in` / `$nin` | 50 | |
| Path length | 256 characters, 10 segments | |
| String operand length | 1024 characters | |
| Forbidden path segments | `__proto__`, `constructor`, `prototype` | Prototype-pollution hygiene |

With these limits, evaluating one filter is at most a few hundred property lookups and comparisons,
regardless of the event.

## Examples

These are the unit-test cases for the engine (AC6.1). Each has an event that matches and one that does not.

**1. Shorthand equality**

```json
{ "body": { "type": "order.created" } }
```

- Matches: `{ "type": "order.created", "id": 1 }`
- Does not match: `{ "type": "order.updated" }`

**2. Nested path with a numeric range**

```json
{ "body": { "data.amount": { "$gte": 100, "$lt": 1000 } } }
```

- Matches: `{ "data": { "amount": 250 } }`
- Does not match: `{ "data": { "amount": 1000 } }`; also `{ "data": { "amount": "250" } }` (a string is not a number)

**3. One of several values**

```json
{ "body": { "type": { "$in": ["invoice.paid", "invoice.payment_failed"] } } }
```

- Matches: `{ "type": "invoice.paid" }`
- Does not match: `{ "type": "invoice.created" }`

**4. Excluding values, and what missing means**

```json
{ "body": { "data.status": { "$nin": ["draft", "test"] } } }
```

- Matches: `{ "data": { "status": "live" } }`; also `{ "data": {} }` (missing satisfies `$nin`)
- Does not match: `{ "data": { "status": "draft" } }`

**5. Presence**

```json
{ "body": { "data.customer.email": { "$exists": true } } }
```

- Matches: `{ "data": { "customer": { "email": null } } }` (present, value null)
- Does not match: `{ "data": { "customer": {} } }`

**6. Header match**

```json
{ "headers": { "x-github-event": "push" } }
```

- Matches: headers `{ "x-github-event": "push" }` (sent as `X-GitHub-Event: push`)
- Does not match: headers `{ "x-github-event": "pull_request" }`

**7. Prefix on a string**

```json
{ "body": { "ref": { "$startsWith": "refs/heads/release/" } } }
```

- Matches: `{ "ref": "refs/heads/release/1.4" }`
- Does not match: `{ "ref": "refs/heads/main" }`

**8. Contains, on a string and on an array**

```json
{ "body": { "message": { "$contains": "urgent" }, "labels": { "$contains": "billing" } } }
```

- Matches: `{ "message": "urgent: card declined", "labels": ["billing", "eu"] }`
- Does not match: `{ "message": "urgent: card declined", "labels": ["shipping"] }`

**9. OR inside a section**

```json
{ "body": { "$or": [ { "data.country": "DE" }, { "data.currency": "EUR" } ] } }
```

- Matches: `{ "data": { "country": "FR", "currency": "EUR" } }`
- Does not match: `{ "data": { "country": "US", "currency": "USD" } }`

**10. NOT at condition level**

```json
{ "body": { "data.email": { "$not": { "$contains": "@example.com" } } } }
```

- Matches: `{ "data": { "email": "ana@acme.io" } }`; also `{ "data": {} }` (the nested `$contains` is false, so `$not` is true)
- Does not match: `{ "data": { "email": "test@example.com" } }`

**11. Top-level OR across sections**

```json
{ "$or": [ { "headers": { "x-priority": "high" } }, { "body": { "data.amount": { "$gt": 10000 } } } ] }
```

- Matches: headers `{}`, body `{ "data": { "amount": 25000 } }`
- Does not match: headers `{ "x-priority": "low" }`, body `{ "data": { "amount": 50 } }`

**12. Query parameter and array index**

```json
{ "query": { "env": "prod" }, "body": { "items.0.sku": { "$startsWith": "SUB-" } } }
```

- Matches: query `?env=prod`, body `{ "items": [ { "sku": "SUB-123" } ] }`
- Does not match: query `?env=prod`, body `{ "items": [] }` (index 0 is missing)

**13. ISO timestamp comparison**

```json
{ "body": { "created_at": { "$gte": "2026-01-01T00:00:00Z" } } }
```

- Matches: `{ "created_at": "2026-03-10T08:00:00Z" }`
- Does not match: `{ "created_at": "2025-12-31T23:59:59Z" }`

**14. Combining everything**

```json
{
  "body": {
    "type": { "$in": ["order.created", "order.updated"] },
    "$not": { "data.test": true },
    "$and": [
      { "data.total": { "$gt": 0 } },
      { "$or": [ { "data.channel": "web" }, { "data.channel": { "$exists": false } } ] }
    ]
  },
  "headers": { "x-environment": { "$neq": "staging" } }
}
```

- Matches: headers `{}`, body `{ "type": "order.created", "data": { "total": 40 } }`
- Does not match: headers `{}`, body `{ "type": "order.created", "data": { "total": 40, "test": true } }`

**Rejected by validation** (each is a test for `parseFilter`):

| Filter | Reason |
|---|---|
| `{ "body": { "a": { "$regex": "x" } } }` | unknown operator |
| `{ "body": { "__proto__.polluted": true } }` | forbidden path segment |
| `{ "body": { "a": { "$in": [] } } }` | `$in` needs at least one item |
| `{ "body": { "a": {} } }` | a condition object needs at least one operator |
| `{ "payload": { "a": 1 } }` | unknown section |
| `{ "body": { "a": { "$eq": { "x": 1 } } } }` | operand must be a primitive |
| six nested `$not` | depth limit |

## Why not JSONata, JSONPath, or `eval`

| Option | Why not |
|---|---|
| `eval` / `new Function` | Tenants would run arbitrary code inside the worker: secrets, network, and other tenants' data are all reachable. Sandboxing JavaScript in-process is not reliable |
| JSONata | A full expression language with functions, recursion, and regular expressions. Tenants could write expressions that run for seconds (including catastrophic regex backtracking). It is a sizeable dependency to audit, and its semantics would have to be explained to every user |
| JSONPath + comparison | Smaller, but implementations differ, several have had code-injection issues through script expressions, and it still needs a comparison layer on top |
| JSON Schema | Good at "is this shape valid", awkward for "route when amount > 100", and verbose |
| **Small JSON DSL (chosen)** | Total and bounded: every filter terminates in a known number of steps. No code execution. Easy to validate with Zod, to render in a form, and to explain. About 200 lines that we fully test |

The cost is expressiveness: no regular expressions, no arithmetic, no comparing two fields with each other,
no searching inside arrays of objects. Those are deliberate omissions for a first version.
