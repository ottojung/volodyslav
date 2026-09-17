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

A completely absent installation is not an ordinary synchronization receiver. It first uses the receiver-less restoration/fresh-creation lifecycle.

A pre-Journal legacy installation likewise does not ordinary-sync directly against current Journal state. It first completes whatever bootstrap/migration lifecycle the running software explicitly supports. An old canonical artifact whose target is unsupported by current software fails lifecycle compatibility rather than being implicitly upcast by synchronization.

## Pairwise synchronization sequence

A successful pairwise synchronization conceptually:

1. acquires/enters the required maintenance publication boundary;
2. opens one stable source snapshot;
3. verifies exact version/schema compatibility from that snapshot;
4. verifies that the source does not prove the receiver behind its own local-writer stream; if it does, stop with `JournalWriterBehindError` and enter the continuation-safe recovery lifecycle instead;
5. transfers every missing immutable **foreign-writer** suffix needed through the captured frontier;
6. validates overlap, contiguity, transitive causal closure, authority extension, and references;
7. computes raw replay;
8. authors only required receiver semantic normalization;
9. deterministically replays/projects final retained history;
10. validates ordinary graph invariants;
11. atomically publishes Journal + matching graph projection.

Imported records retain their original writer identity/body. Receipt itself creates no adoption/acknowledgement event.

A source may contain already-known local-writer records through the receiver's current local head; matching overlap is validated normally. Ordinary synchronization may not treat a *longer* local-writer prefix as sufficient authority to resume that writer.

## Full synchronization

An already-established receiver with frontier zero uses the same suffix-transfer/validation/normalization/replay algorithm. There is no distinct semantic full-sync merge algorithm.

## Same-writer recovery boundary

Suppose receiver local writer is A and an ordinary source contains an agreeing longer A prefix:

```text
receiver: A:1..900
source:   A:1..905
```

The source proves the receiver is behind, but it does not establish that head 905 is continuation-safe under `database-lifecycle.md` §4.1.

Therefore ordinary synchronization does **not** activate `A:901..905` and continue at 906. It fails `JournalWriterBehindError` without changing the active receiver. The lifecycle must instead query `InstallationRecoverySource` and may resume A only when that source guarantees that, after recovery, no previously-authored higher A record can later enter supported retained history.

Any overlap disagreement is `JournalForkError`.

This does not cover interrupted canonical bootstrap before local Journal cutover; creator-resume is a separate lifecycle transition.

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

After union/structural normalization, let K's replay-selected certificate be C. If K's own effective proof is complete for every selected direct input and covers current-value invalidations, but at least one direct input is stale, K is stale solely through recursive input freshness.

Synchronization then ensures K has an uncovered value-scoped:

```text
InvalidateEvent(
    node=K,
    scope={kind:"value", value=currentValueId(K)},
    reason="sync"
)
```

unless an applicable marker already exists.

This applies even when the selected occurrence was newly imported/selected. It preserves the graph's persistent propagated-stale flag so a later upstream `Unchanged` cannot silently make K fresh without K itself validating/recomputing.

No extra sync marker is required merely for a current effective-proof deficit, an uncovered node invalidation, or an already-uncovered value-scoped marker; those are already persistent own-state reasons for staleness.

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

These are separate lifecycle transitions:

- **absent restore** — recovers this installation's continuing writer identity/history through a continuation-safe recovery source before ordinary sync;
- **reset** — rebaselines an established receiver to a source projection relative to observed history; if source is ahead for the receiver's own writer it fails before import/authorship and requires recovery first; for every removed incoming edge `D -> K` of preserved occurrence V it uses edge-specific `proof(V,D)` negative evidence, while persistent target stale flags use current-value invalidation;
- **pre-Journal bootstrap** — uses one frozen canonical cut for a supported semantic-identity bootstrap target; creator may resume an interrupted first cutover; equal occurrences reuse canonical ValueIds, exact shared proof is conservatively intersected with joining proof via `proof(V,D)` barriers, divergent values are concurrent historical facts using legacy `modifiedAt`, stale shared/recursive state is preserved conservatively, and local absence is not deletion evidence;
- **Journal-aware migration** — rewrites retained records through one total canonical per-record format transformation, preserves ValueIds for occurrence-preserving changes, uses edge-specific proof barriers/persistent stale markers when graph flags require them, and may independently author new ValueIds for genuine replacements.

A non-total Journal format codec is `JournalVersionCompatibilityError` before cutover.

Two independent late bootstrap joiners may assign distinct ValueIds to the same non-canonical legacy occurrence; this accepted trade-off may later stale dependents naming the losing occurrence.

Bootstrap lifecycle does not reuse reset semantics or import post-bootstrap current history. Ordinary synchronization begins only after the local lifecycle reaches a current version exactly compatible with the source snapshot.

Independent genuine replacement migrations may later stale dependents after synchronization when certificates name a losing replacement ValueId. This is accepted; no canonical migration participant is required.

Ordinary synchronization itself never performs these lifecycle transitions implicitly.
