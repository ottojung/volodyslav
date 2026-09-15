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

## Pairwise synchronization sequence

A successful pairwise synchronization conceptually:

1. acquires/enters the required maintenance publication boundary;
2. opens one stable source snapshot;
3. verifies exact version/schema compatibility from that snapshot;
4. transfers every missing immutable writer suffix needed through the captured frontier;
5. validates overlap, contiguity, transitive causal closure, authority extension, and references;
6. computes raw replay;
7. authors only required receiver semantic normalization;
8. deterministically replays/projects final retained history;
9. validates ordinary graph invariants;
10. atomically publishes Journal + matching graph projection.

Imported records retain original writer identity/body. Receipt itself creates no adoption/acknowledgement event.

## Full synchronization

An already-established receiver with frontier zero uses the same suffix-transfer/validation/normalization/replay algorithm. There is no distinct semantic full-sync merge algorithm.

## Same-writer recovery

If the source contains an exact longer copy of the receiver's own writer prefix, controlled recovery may import that suffix and continue authoring strictly after the recovered head.

Any overlap disagreement is a writer fork/corruption condition.

## Projection rather than fieldwise merge

Synchronization does not separately merge `values`, `freshness`, `timestamps`, `valid`, or identifier maps as independent authorities.

The active graph after synchronization is the materialized projection of final retained Journal history.

## Dependency closure

A supported published graph is dependency-closed under the current schema.

If imported history selects absence for an input while a dependent remains selected, synchronization authors explicit `DeleteEvent(reason="sync")` over the required dependent closure rather than merely hiding the dependent as latent state.

## Persistent propagated staleness

After union/structural normalization, if selected current occurrence K has a selected certificate which:

- exactly matches every selected direct input ValueId;
- covers current-value invalidations;
- would otherwise establish freshness;
- but at least one direct input is stale;

then synchronization ensures K has an uncovered value-scoped `InvalidateEvent(reason="sync")` for its current ValueId.

This applies even when the selected occurrence was newly imported/selected during this synchronization.

## Atomic publication

Synchronization never exposes:

```text
new Journal + old graph
```

or:

```text
old Journal + new graph
```

Staging/derived scratch state may be incomplete off to the side, but one supported cutover publishes the matching pair.

## Streamability

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
- **pre-Journal bootstrap** — uses one canonical semantic bootstrap basis chosen through the cohort-bootstrap-source decision; a joining legacy host may append a local bootstrap delta while preserving canonical ValueIds for unaffected occurrences;
- **Journal-aware migration** — rewrites retained representation deterministically, preserves ValueIds for `keep`/`override`/`invalidate` and other occurrence-preserving changes, and may independently author new ValueIds for genuine replacement occurrences.

Independent genuine replacement migrations may later make dependents stale after synchronization when certificates name a losing replacement ValueId. This is accepted; no canonical migration participant is required.

Ordinary synchronization itself never performs these lifecycle transitions implicitly.