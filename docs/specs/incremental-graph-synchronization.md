# Specification for IncrementalGraph Synchronization

## Status and scope

For database versions using Journal 3, synchronization is immutable Journal replication followed by Journal-defined normalization and deterministic replay/projection.

This document states the surrounding IncrementalGraph lifecycle obligations. The detailed semantic algorithm is normative in `incremental-graph-journal-sync.md`.

It intentionally does not define or require a new Git/backend transport protocol.

## Journal-first synchronization

A supported current database is semantically:

```text
retained immutable Journal history
+ derived materialized IncrementalGraph projection
```

Synchronization does not merge `values`, `freshness`, `timestamps`, `valid`, or identifier maps as independent authorities.

For an already-established receiver it:

1. opens one stable source `JournalSnapshot`;
2. checks exact source snapshot `databaseVersion` / `graphSchemeString` against receiver metadata;
3. imports every missing writer suffix;
4. validates overlap, contiguity, transitively closed event contexts, authority extension, and ValueId reference causality;
5. performs required Journal synchronization normalization;
6. deterministically replays/projects final retained history;
7. validates ordinary graph invariants;
8. atomically publishes Journal + matching graph projection.

An established fresh receiver with frontier zero uses the same algorithm. A completely absent installation first uses the receiver-less restoration lifecycle in `database-lifecycle.md`; ordinary synchronization does not invent its writer identity.

## Stable compatibility boundary

The held source snapshot contains from one immutable committed source state:

```text
databaseVersion
graphSchemeString
localWriter
frontier
records
```

Sync must not authorize journal interpretation from metadata read before opening that snapshot.

Version/schema mismatch is `JournalVersionCompatibilityError`, not implicit migration.

## Causal-history requirements

Every imported semantic event F=(W,q) must satisfy:

```text
F.context[W] == q - 1
```

and, for every semantic event E included by F.context:

```text
E.context <= F.context
```

componentwise.

Thus `happenedBefore` is transitive and invalidation coverage/proof causality remain reliable after histories merge.

A malformed immutable source context is rejected; it is never expanded/rewritten by the receiver.

## History transfer

Imported records keep exact writer/sequence/body.

Receiving B:73 means retaining B:73, not authoring a receiver-side adoption event.

A source with a longer exact prefix of the receiver's own writer stream may restore that suffix under exclusive maintenance. Any overlapping disagreement is a writer fork.

## Graph conflict/proof semantics

Value/Delete heads use Journal authority.

Equal payloads do not collapse distinct ValueIds.

Validation/freshness/validity come from retained certificates and invalidations.

For one current occurrence, replay selects an eligible certificate by:

```text
1. greatest basisMatchCount
2. coversValueInvalidations == true over false
3. greatest authority
```

so a greater-clock concurrent validation cannot defeat an equally matching causally later validation which actually covered the occurrence's invalidation.

## Synchronization normalization

History union may reveal graph transitions neither input had separately persisted for the receiver's materialized dependent set.

Journal 3 therefore permits exactly the required semantic repairs, principally:

1. **dependency-closure deletion** — explicit `DeleteEvent(reason="sync")` over selected cached nodes whose required inputs are absent;
2. **persistent input-staleness propagation** — value-scoped `InvalidateEvent(reason="sync")` for every selected occurrence whose own selected certificate is complete/covering but whose direct input is stale.

The second rule applies even when synchronization selected a new imported ValueId.

These events are real receiver-authored semantic history, not transport acknowledgements.

## Computor prohibition

Synchronization MUST NOT invoke computors.

Imported ValueEvents already contain payloads/timestamps. Normalization is structural/proof/freshness history only.

## Atomic publication

Transfer may construct an inactive target.

Successful cutover publishes exactly:

```text
(targetJournal, project(targetJournal))
```

plus matching local writer allocator/high-water/derived state.

Failure before cutover leaves the previous active supported pair selected apart from disposable staging.

## Full/initial synchronization

For an **established receiver**:

```text
frontier 0 -> source q
```

is the same suffix algorithm as:

```text
frontier p -> source q
```

Only the starting frontier differs.

This statement does not replace the separate absent-installation restore transition.

## Streamability/performance

Missing writer suffixes are streamable by writer range without loading the whole history/suffix into RAM.

Normalization may currently require graph-sized derived/scratch work. #1607 owns a future end-to-end change-sensitive time theorem.

## Delayed replicas and convergence

Correctness does not require every peer to acknowledge or return.

A delayed replica can later obtain missing immutable suffixes.

After non-normalization graph changes stop, synchronization can author only finite negative normalization consequences over finite positive history/schema. Under fair dissemination all participating replicas in that actual execution eventually reach equivalent projections and repeated sync becomes a no-op.

Different counterfactual source schedules may have authored different real normalization history; Journal 3 does not claim counterfactual confluence across those different executions.

## Multi-source partial success

An outer procedure may process source snapshots sequentially. Each successful pairwise source commit may remain even if a later source fails, unless the outer API explicitly promises a stronger all-sources transaction.

## Reset, restore, bootstrap, migration

These are separate lifecycle transitions:

- **absent restore** — recovers this installation's continuing writer identity/history before ordinary sync;
- **reset** — minimally rebaselines an established receiver to a source projection while retaining history;
- **pre-Journal bootstrap** — a reconciled cohort shares one canonical semantic bootstrap history rather than independently minting baseline ValueIds;
- **Journal-aware migration** — rewrites retained representation deterministically, preserves ValueIds for preserved occurrences, and authors only required semantic changes; migrations which genuinely create/replace occurrences use one canonical semantic migration history across the cohort.

Ordinary synchronization itself never performs these transitions implicitly.