# IncrementalGraph Synchronization

## Scope

For Journal-3-compatible database versions, synchronization means Journal replication plus deterministic replay/projection.

This document is the IncrementalGraph-facing lifecycle shell. The normative Journal protocol is in:

- `incremental-graph-journal-sync.md`;
- `incremental-graph-journal-replay.md`;
- `incremental-graph-journal-well-formedness.md`;
- `incremental-graph-journal-api.md`.

Existing transport mechanisms may continue to discover/carry stable source snapshots. Transport does not define semantic conflict resolution.

## Public behavior

Existing graph-facing operations remain conceptually unchanged:

```text
pull(...)
invalidate(...)
synchronize(...)
```

Synchronization never invokes computors.

It may change selected value occurrences, presence, identifiers, freshness, validity, and timestamps by importing Journal history, replaying it, and authoring required receiver normalization.

## Preconditions

Ordinary pairwise synchronization requires an already-established receiver with:

- current local writer identity;
- valid current Journal/projection pair;
- current database version/schema metadata.

It opens one stable source JournalSnapshot and requires exact compatibility from that same immutable source cut:

```text
snapshot.databaseVersion == receiver.databaseVersion
snapshot.graphSchemeString == receiver.graphSchemeString
```

A completely absent installation is not an ordinary synchronization receiver. It first uses receiver-less restoration/fresh-creation lifecycle.

A pre-Journal legacy installation likewise does not ordinary-sync directly against current Journal state. It first completes whatever bootstrap/migration lifecycle the running software explicitly supports. An old canonical artifact whose target is unsupported by current software fails lifecycle compatibility rather than being implicitly upcast by synchronization.

## Pairwise synchronization sequence

A successful pairwise synchronization conceptually:

1. acquires/enters required maintenance publication boundary;
2. opens one stable source snapshot;
3. verifies exact version/schema compatibility from that snapshot;
4. transfers every missing immutable writer suffix needed through captured frontier;
5. validates overlap, contiguity, transitive causal closure, authority extension, and references;
6. computes raw replay;
7. authors only required receiver semantic normalization;
8. deterministically replays/projects final retained history;
9. validates ordinary graph invariants;
10. atomically publishes Journal + matching graph projection.

Imported records retain original writer identity/body. Receipt itself creates no adoption/acknowledgement event.

## Full synchronization

An already-established receiver with frontier zero uses same suffix-transfer/validation/normalization/replay algorithm. There is no distinct semantic full-sync merge algorithm.

## Same-writer recovery

If source contains exact longer copy of receiver's own **Journal** writer prefix, controlled recovery may import suffix and continue authoring strictly after recovered head.

Any overlap disagreement is writer fork/corruption.

This does not cover interrupted canonical bootstrap before local Journal cutover; creator-resume is a separate lifecycle transition.

## Projection rather than fieldwise merge

Synchronization does not separately merge `values`, `freshness`, `timestamps`, `valid`, or identifier maps as independent authorities.

Active graph after synchronization is materialized projection of final retained Journal history.

## Dependency closure

A supported published graph is dependency-closed under current schema.

If imported history selects absence for input while dependent remains selected, synchronization authors explicit `DeleteEvent(reason="sync")` over required dependent closure rather than hiding dependent as latent state.

## Persistent propagated staleness

After union/structural normalization, if selected current occurrence K has selected certificate which:

- exactly matches every selected direct input ValueId;
- covers current-value invalidations;
- would otherwise establish freshness;
- but at least one direct input is stale;

then synchronization ensures K has uncovered value-scoped `InvalidateEvent(reason="sync")` for current ValueId.

This applies even when selected occurrence was newly imported/selected.

## Atomic publication

Synchronization never exposes new Journal + old graph or old Journal + new graph.

Staging/derived scratch state may be incomplete off to side, but one supported cutover publishes matching pair.

## Streamability

Missing writer suffixes are streamable by writer range without loading whole history/suffix into RAM.

Normalization may currently require graph-sized derived/scratch work. #1607 owns future end-to-end change-sensitive time theorem.

## Delayed replicas and convergence

Correctness does not require every peer to acknowledge or return.

A delayed replica can later obtain missing immutable suffixes.

After non-normalization graph changes stop, synchronization can author only finite negative normalization consequences over finite positive history/schema. Under fair dissemination all participating replicas in that actual execution eventually reach equivalent projections and repeated sync becomes no-op.

Different counterfactual source schedules may have authored different real normalization history; Journal 3 does not claim counterfactual confluence across those executions.

## Multi-source partial success

An outer procedure may process source snapshots sequentially. Each successful pairwise source commit may remain even if later source fails, unless outer API explicitly promises stronger all-sources transaction.

## Reset, restore, bootstrap, migration

These are separate lifecycle transitions:

- **absent restore** — recovers this installation's continuing writer identity/history before ordinary sync;
- **reset** — rebaselines established receiver to source projection relative to observed history; proof weakening for preserved V uses occurrence-scoped `proof(V)` barrier, while persistent target stale flags use current-value invalidation;
- **pre-Journal bootstrap** — uses one frozen canonical cut for a supported semantic-identity bootstrap target; creator may resume an interrupted first cutover; equal occurrences reuse canonical ValueIds, divergent values are concurrent historical facts using legacy `modifiedAt`, stale shared/recursive state is preserved conservatively, and local absence is not deletion evidence;
- **Journal-aware migration** — rewrites retained records through canonical per-record format transformation, preserves ValueIds for occurrence-preserving changes, uses proof barriers/persistent stale markers when graph flags require them, and may independently author new ValueIds for genuine replacements.

Two independent late bootstrap joiners may assign distinct ValueIds to same non-canonical legacy occurrence; this accepted trade-off may later stale dependents naming losing occurrence.

Bootstrap lifecycle does not reuse reset semantics or import post-bootstrap current history. Ordinary synchronization begins only after local lifecycle reaches a current version exactly compatible with source snapshot.

Independent genuine replacement migrations may later stale dependents after synchronization when certificates name losing replacement ValueId. This is accepted; no canonical migration participant is required.

Ordinary synchronization itself never performs these lifecycle transitions implicitly.
