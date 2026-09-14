# IncrementalGraph Journal 3 Record Well-Formedness

## Purpose

This document defines cross-record validity rules which are stronger than syntactic decoding.

A record can have a valid JSON/object shape yet still be impossible Journal 3 history—for example, a validation which names a value occurrence the validating writer had not observed yet.

Supported retained history must satisfy these rules before replay or synchronization may treat the records as semantic evidence.

## Reference causality

For semantic events E and F, `happenedBefore(E,F)` is defined by `incremental-graph-journal-types.md`.

Whenever one semantic event contains a `ValueId` reference to a historical value occurrence V, that reference is admissible only when V actually happened before the referencing event, except where the referenced ValueEvent is an earlier record in the same atomic publication—in which case same-writer sequence order itself establishes `happenedBefore`.

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

let `event(V)` be the ValueEvent named by `V`.

C is well formed only when:

```text
event(V).node == K
happenedBefore(event(V), C)
```

A validation cannot target a concurrent value, a later same-writer value, or a value from a different semantic node.

## ValidateEvent basis rules

Let:

```text
inputEdges(K) = [D0, D1, ...]
C.basis       = [B0, B1, ...]
```

under the schema interpretation applicable to C's current baseline/state.

For every position i:

- `Bi == "unknown"` is permitted only where `incremental-graph-journal-types.md` permits the unknown sentinel;
- otherwise `Bi` must name a retained ValueEvent Vi such that:

```text
Vi.node == Di
happenedBefore(Vi, C)
```

Therefore a certificate is actual historical evidence of the input occurrences it claims to validate against.

A malformed certificate is rejected; replay must not merely ignore the impossible reference and salvage the rest of the certificate.

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

Core `DeleteEvent` and `ValueEvent` contain no semantic-event ID references, so their cross-record well-formedness is determined by:

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

is necessary but not sufficient for well-formed references.

A referenced event must additionally be in E's causal past according to `happenedBefore`; mere eventual retention somewhere in the journal does not prove observation.

## Same-publication references

Local publication may stage symbolic references before final record IDs exist.

At serialized finalization:

1. referenced semantic records receive earlier same-writer sequence positions;
2. referencing records receive later positions;
3. symbolic references resolve to those exact IDs;
4. the resulting persisted records satisfy `happenedBefore` through same-writer sequence order.

No persisted forward reference within one writer publication is permitted.

## WriterStateRecord references

Core `WriterStateRecord` contains no semantic-event references and has no causal context.

Its meaning is writer-local monotone allocator state at its stream position. Replay validates monotonicity by writer sequence.

## Imported-record validation

Synchronization/import must validate these rules before activating imported history.

If a source provides a syntactically valid record whose reference causality is impossible, the source history is unsupported/corrupt. The receiver must not:

- rewrite the event context;
- replace the referenced ValueId with the receiver's current value;
- use payload equality to find a substitute;
- drop only the bad basis element and keep the rest of the certificate; or
- re-author the source record under a new receiver ID.

## Replay assumption

`project(J)` is defined only for a supported well-formed retained journal J.

Replay may validate well-formedness eagerly during import/open or lazily as referenced records are consumed, but any discovered violation is an error rather than an alternative conflict-resolution path.
