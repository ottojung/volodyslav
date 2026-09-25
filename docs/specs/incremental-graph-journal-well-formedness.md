# IncrementalGraph Journal 3 Well-Formedness

## Purpose

This document defines record-level and cross-record validity conditions required before retained Journal history may be treated as supported replay input.

Replay conflict resolution applies only after these structural/causal checks. Malformed history is not converted into a normal graph conflict merely because deterministic replay could otherwise choose some winner.

## Record identity

For every retained record R:

```text
R.id = (author, sequence)
sequence >= 1
```

For each writer A with retained frontier q, records exist exactly at:

```text
A:1 .. A:q
```

with no durable hole.

Two records with one `JournalRecordId` must have identical canonical current-format meaning. This is the within-history check corresponding to `$id-2567281946348705`; disagreement is a writer fork/corruption condition.

## Current-format record validity

Every retained record is valid under the one record representation selected by the database's current `global/version`.

There is no ordinary mixed-version/per-record-upcast path.

For ValueEvent at least:

- NodeKey is canonical/valid;
- NodeIdentifier is valid;
- payload is valid current-version `ComputedValue`;
- timestamps are valid canonical instants; their relative order is unconstrained;
- reason is valid.

Other event/record variants likewise validate all enum/body fields for the current version.

## ValidateEvent target rule

For:

```text
ValidateEvent C {
    node: K,
    value: V,
    ...
}
```

require:

```text
event(V) is a retained ValueEvent
event(V).node == K
happenedBefore(event(V), C)
```

A validation cannot certify a value occurrence which it had not causally observed.

## Validation basis rules

For validation C of node K:

1. every basis entry has one explicit semantic input NodeKey;
2. no input NodeKey appears more than once;
3. entries are serialized in canonical persisted NodeKeyString order for the current database version;
4. each non-`"unknown"` value names a retained ValueEvent for that exact input NodeKey;
5. each such input ValueEvent happened-before C;
6. `"unknown"` is permitted only for the controlled baseline reasons allowed by the migration/reset/bootstrap specifications.

A normal `compute`, `unchanged`, or `cache-revalidate` validation uses no `"unknown"` and has exactly the current direct input-key set.

A historical certificate whose explicit input set no longer equals the current schema's input set remains structurally intelligible history; it simply is not current-shape-compatible proof.

## Value/proof-scoped InvalidateEvent rule

A value-scoped invalidation has shape:

```text
InvalidateEvent I {
    node: K,
    scope: { kind: "value", value: V }
}
```

A proof-edge barrier has shape:

```text
InvalidateEvent I {
    node: K,
    scope: {
        kind: "proof",
        value: V,
        input: D
    }
}
```

For either occurrence-referencing scope require:

```text
event(V) is a retained ValueEvent
event(V).node == K
happenedBefore(event(V), I)
```

For proof scope additionally require:

- `D` is a valid canonical semantic NodeKey in the current record format;
- the reason is one of the controlled maintenance reasons which may author proof barriers: `bootstrap`, `reset`, or `migration`;
- the lifecycle transition which authored the barrier justified D as the exact incoming proof edge it was retiring for V.

The last condition is an authoring obligation, not a requirement that D remain a direct input under every later schema. Historical proof-edge barriers remain intelligible after schema evolution; current replay applies one only when the selected certificate/current input relation makes that `(V,D)` edge relevant.

A value-scoped invalidation cannot stale a value occurrence which did not yet exist in the invalidating event's causal history.

A proof-edge barrier likewise cannot retire proof for an occurrence which the barrier had not causally observed. It retires only the named `D -> K` proof edge for the named occurrence V; it does not make the whole certificate ineligible and does not affect another input or another ValueId.

Proof scope is reserved for the edge-specific maintenance semantics defined by bootstrap/reset/migration. It is not a substitute encoding for ordinary explicit node invalidation.

## Node-scoped InvalidateEvent rule

A node-scoped invalidation contains no ValueId reference and therefore has no value-reference causality rule.

Its effect is deliberately independent of which value occurrence is currently selected. A later validation covers it only through ordinary event causality.

## DeleteEvent and ValueEvent

Core DeleteEvent and ValueEvent contain no semantic-event-ID references, so their cross-record well-formedness is determined by:

- valid current-format record identity/body;
- valid causally closed context;
- valid authority allocation/order;
- valid NodeKey/payload/timestamp/identifier fields; and
- the global journal invariants.

## Causal context closure

A semantic event context is not merely a set of individually in-range coordinates. It is a causally closed journal cut.

For semantic event F with:

```text
F.id = (W,q)
```

the following are all required.

### Retained-range coverage

For every writer A:

```text
F.context[A] <= retainedFrontier[A]
```

Every record claimed by the context therefore exists in the retained journal.

### Complete local prefix

The writer stream represented by F includes its complete own prefix before F:

```text
F.context[W] == q - 1
```

A smaller own-writer coordinate is malformed even if no explicit ValueId reference happens to expose the omission.

### Transitive closure

For every retained semantic event E included by F's context:

```text
E.id.sequence <= F.context[E.id.author]
```

F's context must also include everything E had observed:

```text
for every writer A:
    E.context[A] <= F.context[A]
```

Thus a context may not contain B:1 while omitting A:1 if B:1 itself observed A:1.

Example malformed history:

```text
A:1

B:1
context = { A:1 }

C:1
context = { B:1, A:0 }
```

Although every coordinate is individually retained, C:1's context is not causally closed because it includes B:1 without including B:1's observed A:1.

These rules ensure that the `happenedBefore` relation defined in the types specification is transitive. A later validation therefore cannot accidentally treat a genuinely transitive causal predecessor as concurrent merely because an intermediate context omitted it.

### Historical bootstrap conversion is not physical-read causality

The normal authoring rule constructs context from semantic history observed by the operation. The one-time pre-Journal conversion has a narrower rule for legacy `ValueEvent(reason="bootstrap")` records.

A joining migration may physically read the frozen canonical bootstrap artifact while converting a local legacy value that historically did **not** observe the canonical conflicting value. Merely reading the artifact during upgrade does not make that old legacy occurrence causally later.

Therefore `incremental-graph-journal-migrations.md` may specify a joining legacy ValueEvent whose cross-writer context omits canonical bootstrap coordinates. Such an event is well formed when:

- its own-writer context is exactly `q-1`;
- every coordinate it does include is retained;
- its actual context is transitively closed;
- it contains no reference requiring the omitted canonical event;
- its authority extends every event it actually claims happened-before.

This is not permission for arbitrary context omission. Ordinary graph operations, synchronization, reset, Journal-aware migration, and bootstrap proof/freshness records use their normal complete semantic-observation contexts.

### Authority consistency

For every semantic event E such that `happenedBefore(E,F)`:

```text
authorityCompare(E,F) < 0
```

A context which claims causal observation but whose event authority does not extend that observation is malformed.

## Same-publication references

Local publication may stage symbolic references before final record IDs exist.

At serialized finalization:

1. referenced semantic records receive earlier same-writer sequence positions;
2. referencing records receive later positions;
3. every semantic event receives an exact own-writer context coordinate equal to its sequence minus one;
4. symbolic references resolve to those exact IDs;
5. semantic-event context construction follows `incremental-graph-journal-types.md` §Causal context;
6. the resulting persisted records satisfy `happenedBefore` and authority monotonicity.

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

NodeIdentifier allocation/reuse semantics are owned by `incremental-graph-journal-types.md` §NodeIdentifier uniqueness basis, including the continuation-safe absent-restoration exception in `incremental-graph-journal-lifecycle.md` §4.1.

## Imported-record validation

Synchronization/import operates only between compatible current database versions and validates these rules before activating imported history.

If a source provides a syntactically valid current-format record whose context closure, authority causality, reference causality, proof-edge scope, or self-described basis is impossible, the source history is unsupported/corrupt.

The receiver must not rewrite/re-author the source event to make it fit its current graph. Cross-version representation rewriting belongs only to the explicit database migration path before ordinary synchronization.

## Replay assumption

`project(J)` is defined only for a supported well-formed retained journal J.

Validation timing follows `$id-6845129073418625`.

- Journal-aware migration and explicit projection rebuild may validate the complete retained Journal.
- Synchronization/reset import validates newly admitted records, receiver-authored maintenance records, and their affected projection/index consequences; unrelated retained history is not rescanned.
- Ordinary local publication validates only its newly allocated batch and projection delta.
- Bootstrap and absent restoration validate their own source/artifact/cutover contracts without adding a full retained-history validation pass merely to re-prove already committed history.

Within those scopes, validation may be eager or lazy as referenced records are consumed, but any discovered violation is an error rather than an alternative conflict-resolution path.

Routine opening of an already-current supported database does not perform retained-history validation; see `$id-7429043816351276`.
