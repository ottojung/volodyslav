---
title: Journal 3 Synchronization Shell (target design)
---

# Journal 3 Synchronization Shell (target design)

**Status:** this document specifies the Journal 3 target synchronization shell. Journal 3 is not yet implemented in the current backend. The shipped host-branch synchronization algorithm remains documented in `incremental-graph-synchronization.md` until the Journal 3 implementation lands.

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

A completely absent installation is not an ordinary synchronization receiver. It first uses the receiver-less restoration/fresh-creation lifecycle.

A pre-Journal legacy installation likewise does not ordinary-sync directly against current Journal state. It first completes whatever bootstrap/migration lifecycle the running software explicitly supports. An old canonical artifact whose target is unsupported by current software fails lifecycle compatibility rather than being implicitly upcast by synchronization.

## Pairwise synchronization sequence

A successful pairwise synchronization conceptually:

1. acquires/enters the required maintenance publication boundary;
2. opens one stable source snapshot;
3. verifies exact version/schema compatibility from that snapshot;
4. applies the own-writer-ahead rule owned by `incremental-graph-journal-lifecycle.md` §5 and `incremental-graph-journal-sync.md` §Receiver-local writer ahead in the source is unsupported state;
5. transfers every missing immutable **foreign-writer** suffix needed through the captured frontier;
6. relies on the supported-prefix identity theorem for historical overlap and validates newly admitted contiguity, transitive causal closure, authority extension, and references;
7. computes raw replay;
8. authors only required receiver semantic normalization;
9. deterministically replays/projects final retained history;
10. validates ordinary graph invariants;
11. atomically publishes Journal + matching graph projection.

Imported records retain their original writer identity/body. Receipt itself creates no adoption/acknowledgement event.

A source may contain already-known local-writer records through the receiver's current local head; matching overlap is validated normally. A longer local-writer prefix is not imported into an existing receiver.

## Full synchronization

An already-established receiver with frontier zero uses the same suffix-transfer/validation/normalization/replay algorithm. There is no distinct semantic full-sync merge algorithm.

## Same-writer rollback boundary

The lifecycle classification is defined normatively in `incremental-graph-journal-lifecycle.md` §5 and the pairwise synchronization failure rule in `incremental-graph-journal-sync.md` §Receiver-local writer ahead in the source is unsupported state. This IncrementalGraph-facing shell adds no separate rollback-recovery semantics.

## Projection rather than fieldwise merge

Synchronization does not separately merge `values`, `freshness`, `timestamps`, `valid`, or identifier maps as independent authorities.

The active graph after synchronization is the materialized projection of final retained Journal history.

## Dependency closure: when the cached value is deleted

A supported published graph is dependency-closed under the current schema.

If selected history makes a required direct input absent while a dependent occurrence remains selected, retaining that dependent would violate the materialization/`oldValue` contract. Synchronization therefore authors explicit `DeleteEvent(reason="sync")` over the required dependent closure rather than hiding the dependent as latent state.

Dependency disagreement by itself is **not** deletion evidence while every required input remains materialized.

## Proof/freshness changes: when the cached value is kept

When every required input remains present, synchronization preserves a selected cached occurrence unless some independent structural/semantic rule makes it unsafe as `oldValue`.

Dependency occurrence changes can instead make incoming validity proof ineffective. Replay evaluates the selected certificate's **effective** basis after applicable `proof(V,D)` barriers; it does not infer proof from payload equality or combine certificates.

Thus a mixed state such as one input being ahead and another behind does not itself force deletion. The dependent remains available as cached `oldValue`; its effective validity/freshness says whether it can cache-revalidate or must run its computor on the next pull.

## Persistent propagated staleness

The synchronization-authored persistent-staleness rule is defined normatively in `incremental-graph-journal-sync.md` §Phase 2: persist staleness caused only by stale direct inputs. This shell adds no second marker rule.

## Atomic publication

Synchronization never exposes new Journal + old graph or old Journal + new graph.

Staging/derived scratch state may be incomplete off to the side, but one supported cutover publishes the matching pair.

## Streamability

Missing foreign-writer suffixes are streamable by writer range without loading whole history/suffix into RAM.

Normalization may currently require graph-sized derived/scratch work. #1607 owns the future end-to-end change-sensitive time theorem.

## Delayed replicas and convergence

Correctness does not require every peer to acknowledge or return.

A delayed replica can later obtain missing immutable suffixes.

After non-normalization graph changes stop, synchronization can author only finite negative normalization consequences over finite positive history/schema. Under fair dissemination all participating replicas in that actual execution eventually reach equivalent projections and repeated sync becomes no-op.

Different counterfactual source schedules may have authored different real normalization history; Journal 3 does not claim counterfactual confluence across those executions.

## Multi-source partial success

An outer procedure may process source snapshots sequentially. Each successful pairwise source commit may remain even if a later source fails, unless the outer API explicitly promises a stronger all-sources transaction.

## Reset, restore, bootstrap, migration

These are separate Journal lifecycle transitions owned by `incremental-graph-journal-lifecycle.md`. Reset details are normative in `incremental-graph-journal-reset.md`; pre-Journal bootstrap and Journal-aware migration are normative in `incremental-graph-journal-migrations.md`. This synchronization shell does not restate their semantics.
