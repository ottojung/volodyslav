# IncrementalGraph Journal 3 Locking and Atomic Publication

## Purpose

Journal 3 reuses existing IncrementalGraph locking/publication model. It does not introduce an independent lock hierarchy.

Additional requirement is atomic consistency between authoritative Journal history and materialized graph projection.

## Fundamental publication invariant

At every supported observable committed boundary:

```text
persistedGraph == project(retainedJournal)
```

No supported state exposes new journal + old graph or old journal + new graph.

## Ordinary graph operations

Ordinary `pull()`/`invalidate()` work may perform computation before final publication, but exact Journal identities/contexts/authority coordinates are finalized only inside serialized commit boundary.

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

The finalizer must never construct context only from explicit ValueId references; it retains complete closed observed frontier.

Pre-Journal legacy-value conversion is a separate historical-import lifecycle rule. It may intentionally omit canonical bootstrap value from joining bootstrap ValueEvent's context so migration execution read order does not invent causal succession between two pre-existing legacy values.

## Same-publication ordering

Within one successful local publication, deterministic ordering extends all semantic constraints: new value before validation targeting it, referenced same-publication input before certificate, cause before propagated invalidation/deletion, and no record references later same-publication record.

## Existing graph telescope/nighttime behavior

Journal 3 does not weaken existing protection against invalidation/recomputation races. Existing telescope/nighttime/darkroom rules determine legitimate graph transition; Journal finalization records that settled transition.

## Synchronization

Pairwise synchronization may stream imported records into inactive staging. Before final publication it obtains exclusive maintenance ownership sufficient for atomic receiver cutover.

Receiver-authored sync normalization is finalized after complete imported frontier it normalizes. Imported records retain original contexts/authority/IDs.

## Reset

Reset runs as exclusive maintenance because it observes/imports one source cut and may author semantic repair records.

After computing source/receiver union and target projection it stages only required Value/Delete/Validate/Invalidate intents. Preserved ValueIds are not reallocated merely because reset is under maintenance.

If target proof is weaker than currently selected proof, reset stages node-scoped proof barrier before target validation. If target stores a persistently stale occurrence whose own proof is complete, reset stages value-scoped invalidation even when recursive input staleness already makes current replay stale.

Reset-authored events are causally after complete union they intentionally supersede.

## Absent-installation restore

Receiver-less restoration of absent installation does not author semantic Journal records merely to copy already-existing history.

It atomically establishes local storage containing held restored history/projection and adopts snapshot `localWriter` before ordinary writes are enabled.

## Pre-Journal canonical bootstrap

Installation reaching bootstrap gate first obtains configured cohort-bootstrap-source decision.

- compatible immutable `CanonicalBootstrapSnapshot` -> choose creator-resume or ordinary join based on local fingerprint;
- definite absence suitable for first creation -> create canonical bootstrap under exclusive maintenance and freeze final cut before ordinary authoring;
- indeterminate/error -> fail without creating semantic bootstrap history.

A release which does not support artifact target version/schema fails compatibility before staging bootstrap history; no permanent cross-version bootstrap machinery is implied.

### Canonical creation and creator-resume crash window

Canonical artifact becomes durable before `createCanonicalBootstrap` reports success/ordinary Journal authoring begins.

If artifact publication succeeds but creator's local active cutover fails, restart may find pre-Journal local state plus artifact with same `creatorWriter`.

Under exclusive maintenance creator-resume:

1. validates local legacy target equals artifact projection;
2. on mismatch fails `JournalBootstrapForkError` without changing active state;
3. on equality installs exactly artifact Journal stream and projection, reconstructs allocator/high-water/index state, and atomically cuts over;
4. allocates no duplicate semantic records merely to resume.

A different fingerprint cannot use this path.

### Ordinary bootstrap join

Bootstrap join is **not** reset publication:

- equal legacy occurrences reuse canonical ValueIds;
- local-only/different occurrences are converted into historical joining-writer bootstrap ValueEvents;
- divergent local ValueEvents use legacy `modifiedAt` authority and do not observe canonical conflicts merely because migration read artifact;
- canonical-present/local-absent does not author deletion;
- ordinary authority resolves concurrent value conflicts;
- proof/freshness baseline records are authored afterward with normal closed contexts;
- WriterState preserves local allocator watermark.

Joining writer allocates historical bootstrap ValueEvents in nondecreasing legacy `modifiedAt` order, then returns to normal HLC allocation for proof/freshness records.

Two joiners may assign distinct ValueIds to same non-canonical legacy occurrence; `$id-1635227135166767` accepts resulting possible downstream staleness.

Complete bootstrap-target Journal/projection pair becomes active atomically. Any onward migration happens only through steps running release explicitly supports. Post-bootstrap cohort history arrives later through ordinary compatible synchronization.

## Journal-aware migration

A migration may perform two physically large phases under exclusive maintenance:

1. deterministic representation rewrite of retained old records into inactive target storage;
2. semantic target repair.

Representation rewrite preserves old IDs and allocates no new Journal positions.

When ValueEvent payload representation changes, one pure version-migration codec rewrites every affected retained ValueEvent identically regardless of local selection.

For semantic-preserving `override()`, callback result is checked against canonical rewrite of selected record. It cannot supply replica-local bytes for immutable record. Mismatch fails before cutover.

Semantic migration preserves selected ValueIds for occurrence-preserving decisions and stages semantic events required by target:

- ValueEvent for genuine new/replaced occurrence;
- DeleteEvent for required absence;
- node-scoped InvalidateEvent as proof barrier when target removes current validity;
- ValidateEvent for exact target proof after any barrier;
- value-scoped InvalidateEvent for persistent target stale state, including stale-only-through-input when own proof is ready;
- WriterStateRecord when local allocator watermark changes.

Replicas do not need shared canonical migration author. Independent genuine replacements may later conflict/stale dependents normally.

## Atomic inactive-target cutover

For synchronization/reset/bootstrap/migration, implementation may build inactive target containing target Journal, graph projection, global metadata, and derived indexes.

Only after validation/durable flushing succeeds may it atomically switch active selection.

Failure before cutover leaves old supported active database selected. Incomplete staging is disposable and has no semantic authority.

Canonical-artifact publication is the one deliberate two-location bootstrap boundary: artifact may become durable before creator's local active cutover. The creator-resume rule makes that intermediate crash state recoverable without duplicate semantic history.

## Projection rebuild

Projection rebuild is exclusive maintenance over fixed authoritative Journal state. It may reconstruct graph sublevels and derived indexes without authoring semantic history.

## Lock ordering/deadlock requirement

Journal 3 introduces no independent Journal mutex acquired in arbitrary order relative to existing graph locks.

Implementations integrate Journal publication into existing transaction/maintenance ownership so there is one documented acquisition order.

A correctness-preserving optimization may shorten exclusive windows, but it must not expose split Journal/projection state or finalize semantic records from stale/unclosed causal frontier.
