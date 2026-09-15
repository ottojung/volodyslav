# IncrementalGraph Journal 3 Locking and Atomic Publication

## Purpose

Journal 3 reuses the existing IncrementalGraph locking/publication model. It does not introduce an independent lock hierarchy.

The additional requirement is atomic consistency between authoritative Journal history and its materialized graph projection.

## Fundamental publication invariant

At every supported observable committed boundary:

```text
persistedGraph == project(retainedJournal)
```

No supported state exposes:

```text
new journal + old graph
```

or:

```text
old journal + new graph
```

## Ordinary graph operations

Ordinary `pull()`/`invalidate()` work may perform computation before final publication, but exact Journal identities/contexts/authority coordinates are finalized only inside the serialized commit boundary.

The operation may stage semantic intents while computation is running.

At finalization it:

1. reacquires/holds the existing publication/darkroom protection required by the graph;
2. observes the latest committed graph and Journal frontier;
3. validates/reconciles the staged transition against that committed state;
4. allocates one contiguous local writer range;
5. orders records according to semantic reference/dependency constraints;
6. assigns every semantic event `(W,q)` exact own-writer context `q-1` and the complete observed causally closed cross-writer frontier;
7. allocates AuthorityTimes after every observed causal predecessor;
8. atomically writes finalized Journal records and corresponding graph mutations;
9. updates volatile allocator/index caches only after durable success.

A failed ordinary operation consumes no durable Journal sequence position.

## Why contexts are finalized under the commit boundary

A context describes the complete history actually observed by the committed event, not the history that happened to exist when computation began.

If another allowed operation commits before finalization, the final event context must reflect the causally observed committed state required by the locking/operation semantics.

The finalizer must never construct a context only from explicit ValueId references. It must retain the complete closed observed frontier so `happenedBefore` remains transitive.

## Same-publication ordering

Within one successful local publication, deterministic ordering must extend all semantic constraints.

At minimum:

- a new ValueEvent precedes a ValidateEvent targeting it;
- any same-publication input value referenced by a certificate precedes that certificate;
- direct/root invalidation/change precedes propagated dependent invalidations caused by it;
- structural cause deletion precedes dependent sync/reset/migration deletion caused by it;
- no record references a later same-publication record.

Non-semantic WriterStateRecord placement may be chosen deterministically as long as replayed writer state and reference/context rules remain correct.

## Existing graph telescope/nighttime behavior

Journal 3 does not weaken existing protection against invalidation/recomputation races.

The graph's existing per-node telescope/nighttime/darkroom rules remain responsible for ensuring that the graph transition being committed is legitimate.

Journal finalization records that legitimate settled transition; it does not create a second concurrency protocol which lets graph operations race around existing locks.

## Synchronization

Pairwise synchronization may stream imported records into inactive staging without blocking ordinary graph reads/writes for the entire transfer, subject to existing lifecycle behavior.

Before final target publication it obtains exclusive maintenance ownership sufficient to make the receiver cutover atomic.

Any receiver-authored sync normalization event is finalized after the complete imported frontier it normalizes:

- next receiver sequence;
- exact own-writer context;
- closed cross-writer context including imported history;
- authority after imported high-water.

Imported records themselves retain their original immutable contexts/authority/IDs.

Synchronization publishes staging only when final Journal validation/replay succeeds.

## Reset

Reset runs as exclusive maintenance because it observes/imports one source cut and may author semantic rebaseline records.

It does **not** reserve a graph-wide baseline record set in advance.

After computing:

```text
J0 = receiver/source union
P0 = project(J0)
PS = source target
```

reset stages only the minimal Value/Delete/Validate/Invalidate intents required by the reset specification.

Final receiver-authored reset records are allocated as one deterministic local writer continuation after the complete observed J0 frontier.

Preserved ValueIds are not reallocated merely because reset is under maintenance.

## Absent-installation restore

Receiver-less restoration of an absent installation does not author semantic Journal records merely to copy already-existing history.

It atomically establishes local storage containing the held restored history/projection and adopts the held snapshot's `localWriter` before ordinary writes are enabled.

If the restored database then requires migration, the migration gate runs under ordinary migration maintenance rules before graph APIs are exposed.

## Pre-Journal canonical bootstrap

The canonical bootstrap source authors the semantic bootstrap history once under exclusive migration maintenance.

Joining legacy installations do not allocate duplicate semantic bootstrap records. They atomically install the canonical semantic history after verifying legacy graph equivalence, preserve their own `localWriter`, and append only local WriterState history needed to preserve their own allocator watermark.

The exact joining-writer record allocation is serialized under that installation's local publication boundary before cutover.

## Journal-aware migration

A migration may perform two physically large phases under exclusive maintenance:

1. deterministic representation rewrite of retained old records into inactive target storage;
2. semantic target repair.

Representation rewrite preserves old IDs and does not allocate new Journal positions.

Semantic migration preserves existing selected ValueIds for unchanged occurrences. It stages new semantic events only for actual target changes:

- ValueEvent for new/replaced occurrence;
- DeleteEvent for required target absence;
- ValidateEvent for changed target proof;
- value-scoped InvalidateEvent for target stale state;
- WriterStateRecord when local allocator watermark changes.

When the migration creates/replaces semantic occurrences, one canonical cohort semantic migration history is authored according to the migration specification. Other participating peers retain those immutable records rather than independently allocating equivalent new ValueIds.

A peer may still author its own local WriterStateRecord as needed to preserve its allocator namespace.

## Atomic inactive-target cutover

For synchronization/reset/bootstrap/migration, an implementation may build an inactive target containing:

```text
target journal
target graph projection
target global metadata
derived indexes
```

Only after validation/durable flushing succeeds may it atomically switch the active selection.

Failure before cutover leaves the old supported active database selected. Incomplete staging is disposable and has no semantic authority.

## Projection rebuild

Projection rebuild is exclusive maintenance over a fixed authoritative Journal state.

It may reconstruct graph sublevels and derived indexes without authoring semantic history.

If the Journal changes during rebuild, the implementation must either prevent that through exclusivity or restart/reconcile against a new fixed cut before publication.

## Lock ordering/deadlock requirement

Journal 3 introduces no independent Journal mutex which can be acquired in arbitrary order relative to existing graph locks.

Implementations must integrate Journal publication into existing transaction/maintenance ownership so there is one documented acquisition order.

A correctness-preserving optimization may shorten exclusive windows, but it must not expose a split Journal/projection state or finalize semantic records from a stale/unclosed causal frontier.