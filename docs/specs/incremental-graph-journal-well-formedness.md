# IncrementalGraph Journal 3 Record Well-Formedness

## Purpose

This document defines cross-record validity rules which are stronger than syntactic decoding.

A record can have a valid object shape yet still be impossible Journal 3 history—for example, a validation which names a value occurrence the validating writer had not observed yet.

Supported retained history must satisfy these rules before replay or synchronization may treat the records as semantic evidence.

## Reference causality

For semantic events E and F, `happenedBefore(E,F)` is defined by `incremental-graph-journal-types.md`.

Whenever one semantic event contains a `ValueId` reference to a historical value occurrence V, that reference is admissible only when V actually happened before the referencing event.

An earlier record in the same atomic publication satisfies this through same-writer sequence order.

Thus Journal 3 never permits an event to claim knowledge of a concurrent or future value occurrence merely because that occurrence happens to be retained in the same eventual journal union.

## ValidateEvent target rule

For:

```text
C = ValidateEvent {
    node: K,
    value: V,
    ...
}
```

let `event(V)` be the ValueEvent named by V.

C is well formed only when:

```text
event(V).node == K
happenedBefore(event(V), C)
```

A validation cannot target a concurrent value, a later same-writer value, or a value from another semantic node.

## Self-describing ValidateEvent basis rules

A validation basis is an array of explicit semantic-input claims:

```text
{
    input: NodeKey,
    value: ValueId | "unknown"
}
```

The basis must not contain two entries with the same `input` NodeKey.

For each entry B:

### Known value

If:

```text
B.value = V
```

then V must name a retained ValueEvent E satisfying:

```text
E.node == B.input
happenedBefore(E, C)
```

The certificate therefore proves exactly which semantic input node and which historical occurrence it claims to validate against.

### Unknown value

If:

```text
B.value == "unknown"
```

then `C.reason` must be one of the controlled baseline reasons for which the type specification permits unknown proof provenance:

```text
bootstrap
reset
migration
```

An ordinary `compute`, `unchanged`, or `cache-revalidate` validation must not contain `"unknown"`.

### Current-schema completeness

When C is authored by an ordinary operation under the current schema, its basis input-key set must equal the current distinct direct structural input set:

```text
set(C.basis.input) == set(inputEdges(C.node))
```

and serialization order follows current `inputEdges(C.node)` order.

A controlled bootstrap/reset/migration baseline likewise records one basis entry for every direct input in its **target** schema interpretation, with `"unknown"` where the target legacy validity edge is intentionally absent.

An old historical certificate remains intelligible after a later schema migration because its basis records its own semantic input NodeKeys explicitly. It is not retroactively malformed merely because the current schema now gives that node a different input set; migration creates a new current ValueId/certificate baseline for the new schema.

## No partial salvage of malformed certificates

A malformed certificate is rejected as an immutable historical record.

Replay/import must not:

- drop one impossible basis entry and keep the others;
- substitute the currently selected ValueId for the named historical one;
- use payload equality to find a replacement occurrence; or
- reinterpret an explicit old input NodeKey as a different current input.

## Value-scoped InvalidateEvent rule

For:

```text
I = InvalidateEvent {
    node: K,
    scope: { kind: "value", value: V },
    ...
}
```

I is well formed only when:

```text
event(V) is a retained ValueEvent
event(V).node == K
happenedBefore(event(V), I)
```

A value-scoped invalidation cannot stale a value occurrence which did not yet exist in the invalidating event's causal history.

## Node-scoped InvalidateEvent rule

A node-scoped invalidation contains no ValueId reference and therefore has no value-reference causality rule.

Its effect is deliberately independent of which value occurrence is currently selected. A later validation covers it only through ordinary event causality.

## DeleteEvent and ValueEvent

Core DeleteEvent and ValueEvent contain no semantic-event-ID references, so their cross-record well-formedness is determined by:

- valid record identity/version;
- valid causal context;
- valid authority allocation/order;
- valid NodeKey/payload/timestamp/identifier fields; and
- the global journal invariants.

## Causal context closure

For every semantic event E and writer A:

```text
E.context[A] <= retainedFrontier[A]
```

is necessary but not sufficient for reference validity.

A referenced event must additionally be in E's causal past according to `happenedBefore`; mere eventual retention somewhere in the journal does not prove observation.

## Same-publication references

Local publication may stage symbolic references before final record IDs exist.

At serialized finalization:

1. referenced semantic records receive earlier same-writer sequence positions;
2. referencing records receive later positions;
3. symbolic references resolve to those exact IDs;
4. the resulting persisted records satisfy `happenedBefore` through same-writer sequence order.

No persisted forward ValueId reference within one writer publication is permitted.

## WriterStateRecord rules

Core WriterStateRecord contains no semantic-event references and has no causal context.

Its meaning is writer-local monotone allocator state at its stream position.

Within one continuing writer stream:

```text
later WriterStateRecord.lastNodeIndex
    >= earlier WriterStateRecord.lastNodeIndex
```

Replay rejects a decreasing watermark.

## Imported-record validation

Synchronization/import must validate these rules before activating imported history.

If a source provides a syntactically valid record whose reference causality or self-described basis is impossible, the source history is unsupported/corrupt.

The receiver must not rewrite/re-author the source event to make it fit its current graph.

## Replay assumption

`project(J)` is defined only for a supported well-formed retained journal J.

Replay may validate well-formedness eagerly during import/open or lazily as referenced records are consumed, but any discovered violation is an error rather than an alternative conflict-resolution path.
