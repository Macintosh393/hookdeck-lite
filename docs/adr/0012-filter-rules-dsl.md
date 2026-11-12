# ADR-0012: Filter rules as a small JSON DSL in `shared`

- **Status**: Accepted
- **Date**: 2026-11-12
- **Deciders**: human lead

## Context

A connection should be able to say "only deliver events where `type` is `order.created` and
`data.amount` ≥ 100". Tenants write these rules, so the rules are untrusted input that runs inside our
worker for every event. They must be safe, bounded in cost, easy to validate, and previewable in the
dashboard before saving.

## Decision

A declarative JSON DSL with three sections (`body`, `headers`, `query`), dot-notation paths, and a fixed
operator set: `$eq`, `$neq`, `$in`, `$nin`, `$exists`, `$gt`, `$gte`, `$lt`, `$lte`, `$contains`,
`$startsWith`, `$and`, `$or`, `$not`.

- Validated by a Zod schema (`parseFilter`) when a connection is saved.
- Evaluated by a pure function (`evaluateFilter`) with no I/O, no `eval`, no regular expressions.
- Limits on size (4 KiB), depth (5), and condition count (50).
- Lives in `packages/shared`, so the worker and the dashboard's filter tester run identical code.

Specification and examples: [FILTER-RULES.md](../FILTER-RULES.md).

## Alternatives considered

| Option | Why not |
|---|---|
| JavaScript expressions via `eval`, `new Function`, or `vm` | Arbitrary code execution in the worker. Node's `vm` module is explicitly not a security boundary |
| An isolated sandbox (`isolated-vm`, a WASM runtime) | Safe if configured correctly, but a native dependency, memory and time limits to manage, and far more than routing needs |
| JSONata | Powerful and well known. It is a Turing-complete expression language with user-defined functions and regex, so cost cannot be bounded by inspection, and it is a large dependency to audit |
| JSONPath | Selects values but does not express conditions by itself; implementations differ; some have had injection vulnerabilities via script expressions |
| JSON Schema as the filter | Standard and validated by mature libraries. Verbose for simple routing conditions and unfamiliar as a "filter" to most users |
| A custom string syntax (`type == "x" && amount > 100`) | Nicer to type, but needs a parser, error reporting with positions, and escaping rules. JSON needs none and is trivially built from a form |
| Engine in `core` or the worker | The dashboard could not import it. A separate browser implementation would drift from the worker's |

## Consequences

- Every filter terminates in a bounded number of steps. There is no way to write a slow or dangerous one.
- The dashboard can preview a rule against a real stored event with exactly the worker's semantics.
- Limited expressiveness: no regex, no arithmetic, no field-to-field comparison, no searching inside
  arrays of objects. Requests for those would be new operators, each with its own cost analysis.
- Semantics had to be decided and documented for missing paths and type mismatches. The examples in the
  spec are the test suite.
- A stored filter that fails validation at evaluation time is treated as "no match" (fail closed).

## What I should be able to explain

**Q: Why not just let users write a JavaScript expression?**
A: It would run with the worker's privileges: environment variables, database, network. In-process
sandboxes for JavaScript are not reliable. A declarative rule cannot do anything but compare values.

**Q: Why did you write your own instead of using JSONata?**
A: Bounded cost and a small audit surface. Our evaluator is a few hundred lines with fixed limits;
JSONata is a full language where a tenant can write an expression that takes seconds.

**Q: What does `$neq` return when the field is missing?**
A: True. A missing value is not equal to anything. To require the field, combine it with `$exists: true`.
