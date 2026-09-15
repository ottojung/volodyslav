# IncrementalGraph Journal 3 Locking and Atomic Publication

## Purpose

Journal 3 reuses the existing IncrementalGraph locking/publication model. It does not introduce an independent lock hierarchy.

The additional requirement is atomic consistency between authoritative Journal history and its materialized graph projection.

## Fundamental publication invariant

At every supported observable committed boundary:

```text
persistedGraph == project(retainedJournal)
```

No supported state exposes new journal + old graph or old journal + new graph.

## Ordinary graph operations

Ordinary `pull()`/`invalidate()` work may perform computation before final publication, but exact Journal identities/contexts/authority coordinates are finalized only inside the serialized commit boundary.

At finalization it:

1. holds existing publication/darkroom protection;
2. observes latest committed graph and Journal frontier;
3. reconciles staged transition against committed state;
4. allocates one contiguous local writer range;
5. orders records according to semantic reference/dependency constraints;
6. assigns every semantic event `(W,q)` own-writer context `q-1` and complete observed closed cross-writer frontier;
7. allocates AuthorityTimes after every observed causal predecessor;
8. atomically writes Journal records and graph mutations;
9. updates volatile allocator/index caches only after durable success.

A failed ordinary operation consumes no durable Journal sequence position.

## Why contexts are finalized under commit boundary

A context describes complete semantic history observed by an ordinary committed event, not history that happened to exist when computation began.

The finalizer must never construct context only from explicit ValueId references; it retains the complete closed observed frontier.

Pre-Journal legacy-value conversion is a separate historical-import lifecycle rule. It may intentionally omit a canonical bootstrap value from a joining bootstrap ValueEvent's context so migration execution read order does not invent causal succession between two pre-existing legacy values.

## Same-publication ordering

Within one successful local publication, deterministic ordering extends all semantic constraints: new value before validation targeting it, referenced same-publication input before certificate, cause before propagated invalidation/deletion, and no record references a later same-publication record.

## Existing graph telescope/nighttime behavior

Journal 3 does not weaken existing protection against invalidation/recomputation races. Existing telescope/nighttime/darkroom rules determine which graph transition is legitimate; Journal finalization records that settled transition.

## Synchronization

Pairwise synchronization may stream imported records into inactive staging. Before final publication it obtains exclusive maintenance ownership sufficient for atomic receiver cutover.

Receiver-authored sync normalization is finalized after the complete imported frontier it normalizes. Imported records retain original contexts/authority/IDs.

## Reset

Reset runs as exclusive maintenance because it observes/imports one source cut and may author semantic repair records.

After computing source/receiver union and target projection it stages only minimal Value/Delete/Validate/Invalidate intents required by reset. Preserved ValueIds are not reallocated merely because reset is under maintenance.

Reset-authored events are causally after the complete union they intentionally supersede.

## Absent-installation restore

Receiver-less restoration of an absent installation does not author semantic Journal records merely to copy already-existing history.

It atomically establishes local storage containing held restored history/projection and adopts snapshot `localWriter` before ordinary writes are enabled.

## Pre-Journal canonical bootstrap

The installation reaching the bootstrap gate first obtains the configured cohort-bootstrap-source decision.

- existing immutable `CanonicalBootstrapSnapshot` -> validate its original bootstrap target version/schema and join it;
- definite absence suitable for first creation -> create canonical bootstrap under exclusive migration maintenance and freeze its final cut before ordinary authoring;
- indeterminate/error -> fail without creating semantic bootstrap history.

The canonical artifact contains exactly the original bootstrap cut. A later current Journal snapshot is not substituted for it.

Bootstrap join is **not** reset publication:

- equal legacy occurrences reuse canonical ValueIds;
- local-only or different legacy occurrences are converted into historical joining-writer bootstrap ValueEvents;
- those divergent local ValueEvents use their legacy `modifiedAt` authority and intentionally do not observe canonical conflicting values merely because migration read the artifact;
- canonical-present/local-absent does not author a deletion;
- ordinary authority resolves concurrent value conflicts;
- proof/freshness baseline records are authored afterward with normal closed contexts over the value records they reference;
- WriterState preserves the local allocator watermark.

The joining writer allocates its historical bootstrap ValueEvents in nondecreasing legacy `modifiedAt` order, then returns to normal HLC allocation for bootstrap proof/freshness records.

The complete bootstrap-target Journal/projection pair becomes active atomically. If the running software is newer than the bootstrap target, the ordinary migration gate continues before graph APIs are exposed.

Post-bootstrap cohort history is never folded into the bootstrap publication. It arrives later through ordinary compatible synchronization.

## Journal-aware migration

A migration may perform two physically large phases under exclusive maintenance:

1. deterministic representation rewrite of retained old records into inactive target storage;
2. semantic target repair.

Representation rewrite preserves old IDs and allocates no new Journal positions.

When ValueEvent payload representation changes, one pure version-migration codec rewrites every affected retained ValueEvent identically regardless of whether that occurrence is selected on the local replica.

For semantic-preserving `override()`, the callback result is checked against the already-determined canonical rewrite of the selected record. It cannot supply replica-local bytes for that immutable record. Mismatch fails migration before cutover.

Semantic migration preserves selected ValueIds for occurrence-preserving decisions and stages new semantic events only for actual target changes:

- ValueEvent for genuine new/replaced semantic occurrence;
- DeleteEvent for required target absence;
- ValidateEvent for changed target proof;
- value-scoped InvalidateEvent for target stale state;
- WriterStateRecord when local allocator watermark changes.

Replicas do not need a shared canonical migration author. If independently migrating replicas genuinely replace the same semantic occurrence, each may allocate its own new ValueId. Later synchronization handles those records normally and may make dependents stale when certificates name a losing replacement occurrence.

## Atomic inactive-target cutover

For synchronization/reset/bootstrap/migration, an implementation may build an inactive target containing target Journal, graph projection, global metadata, and derived indexes.

Only after validation/durable flushing succeeds may it atomically switch active selection.

Failure before cutover leaves old supported active database selected. Incomplete staging is disposable and has no semantic authority.

## Projection rebuild

Projection rebuild is exclusive maintenance over a fixed authoritative Journal state. It may reconstruct graph sublevels and derived indexes without authoring semantic history.

## Lock ordering/deadlock requirement

Journal 3 introduces no independent Journal mutex which can be acquired in arbitrary order relative to existing graph locks.

Implementations integrate Journal publication into existing transaction/maintenance ownership so there is one documented acquisition order.

A correctness-preserving optimization may shorten exclusive windows, but it must not expose split Journal/projection state or finalize semantic records from stale/unclosed causal frontier.
