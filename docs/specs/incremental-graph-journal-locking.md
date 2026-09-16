# IncrementalGraph Journal 3 Locking and Atomic Publication

## Purpose

Journal 3 reuses existing IncrementalGraph locking/publication model. It does not introduce an independent lock hierarchy.

Additional requirement is atomic consistency between authoritative Journal history and materialized graph projection.

## Fundamental publication invariant

At every supported observable committed boundary:

```text
persistedGraph == project(retainedJournal)
```

No supported state exposes new Journal + old graph or old Journal + new graph.

## Ordinary graph operations

Ordinary `pull()`/`invalidate()` may compute before final publication, but exact Journal IDs/contexts/authority coordinates are finalized only inside serialized commit boundary.

Finalization:

1. holds existing publication/darkroom protection;
2. observes latest committed graph/Journal frontier;
3. reconciles staged transition against committed state;
4. allocates one contiguous local writer range;
5. orders records by semantic reference/dependency constraints;
6. assigns exact own-writer context and closed observed cross-writer frontier;
7. allocates AuthorityTimes after causal predecessors;
8. atomically writes Journal records + graph mutations;
9. updates volatile allocator/index caches only after durable success.

Failed ordinary operation consumes no durable Journal coordinate.

## Context finalization

An ordinary event context represents complete semantic history observed by publication, not only explicitly referenced ValueIds.

Pre-Journal historical ValueEvent conversion is the narrow exception: physical reading of canonical artifact during upgrade does not invent causal succession between two already-existing divergent legacy values.

## Same-publication ordering

Deterministic ordering extends semantic constraints: value before validation, referenced same-publication input before certificate, cause before propagated invalidation/deletion, no forward reference.

## Existing graph telescope/nighttime behavior

Journal 3 does not weaken existing invalidation/recomputation race protection. Existing telescope/nighttime/darkroom rules determine legitimate graph transition; Journal finalization records it.

## Synchronization

Sync may stream imported records into inactive staging. Before active publication it obtains exclusive maintenance ownership.

Receiver normalization is finalized after the imported frontier it normalizes. Imported records retain original IDs/contexts/authority.

## Reset

Reset runs as exclusive maintenance over one source cut + receiver union.

It stages only required Value/Delete/Validate/Invalidate records. Preserved ValueIds are not reallocated merely because reset is maintenance.

If target proof is weaker for preserved V, reset stages occurrence-scoped:

```text
Invalidate(scope={kind:"proof",value:V}, reason="reset")
```

before target validation. It does **not** use node scope merely as a certificate-selection barrier.

If target stores persistent stale V while its own proof is otherwise complete, reset stages value-scoped stale marker even when recursive input staleness already makes replay stale.

Reset-authored events causally follow the union they intentionally repair.

## Absent-installation restore

Receiver-less restore authors no semantic history merely to copy already-existing history. It atomically establishes local storage/projection and adopts snapshot `localWriter` before ordinary writes.

## Pre-Journal canonical bootstrap

Bootstrap gate first obtains cohort-bootstrap-source decision:

- compatible immutable artifact -> creator-resume or ordinary join by local fingerprint;
- definite absence suitable for first creation -> canonical creation;
- indeterminate/error -> fail without bootstrap history.

A release which does not support artifact target version/schema fails compatibility before staging.

### Bootstrap semantic-identity boundary

Bootstrap journals the **persisted legacy graph directly**. Before canonical cut it does not run ordinary semantic migration decisions which create/delete/change graph semantics or synthesize wall-clock/allocator-dependent graph facts.

Thus canonical creation and creator-resume never need to regenerate `MigrationStorage.create()` output or other execution-dependent migration results. If actual graph/schema semantic migration is required, it runs only after Journal bootstrap as Journal-aware migration.

### Canonical creation and creator-resume crash window

Canonical artifact becomes durable before ordinary Journal authoring is enabled.

If artifact publication succeeds but creator local active cutover fails, restart may find pre-Journal local state plus artifact with same creator writer.

Creator-resume under exclusive maintenance:

1. compares persisted legacy semantic graph directly with artifact projection; no migration callback reruns;
2. mismatch -> `JournalBootstrapForkError`, no active change;
3. match -> install exact artifact stream/projection, reconstruct allocator/high-water/indexes, cut over;
4. allocate no duplicate semantic records.

A different fingerprint cannot use this path.

### Ordinary bootstrap join

Join is not reset:

- exact equal occurrence reuses canonical ValueId;
- local-only/different occurrence becomes historical joining ValueEvent using persisted legacy modifiedAt;
- divergent value does not observe canonical conflict solely because bootstrap read artifact;
- canonical presence/local cache absence creates no delete;
- exact shared occurrence retains canonical proof basis rather than receiving a joining-side validation merely to strengthen proof;
- exact shared occurrence is persistently stale if either legacy side was stale;
- after direct stale roots, deterministic dependency-topological propagation adds value-scoped bootstrap markers for selected occurrences stale solely through stale inputs;
- WriterState preserves local allocator watermark.

This ensures a fresh joiner cannot clear canonical stale state and an upstream `Unchanged` cannot later freshen a bootstrap-propagated stale dependent.

Two joiners may assign distinct ValueIds to same non-canonical occurrence as accepted by `$id-1635227135166767`.

Complete bootstrap-target Journal/projection pair becomes active atomically. Onward semantic migration and post-bootstrap synchronization happen only afterward.

## Journal-aware migration

Migration may perform:

1. deterministic whole-history representation rewrite into inactive target;
2. semantic target repair.

Representation rewrite preserves old IDs and allocates no new Journal positions.

One pure version codec rewrites every affected retained ValueEvent identically regardless of local selection. `override()` only asserts selected callback result equals canonical codec output.

Semantic migration may stage:

- ValueEvent for genuine new/replaced occurrence;
- DeleteEvent for target absence;
- node-scoped InvalidateEvent for a true explicit migration `invalidate()`;
- occurrence-scoped `proof(V)` barrier for maintenance-only proof weakening of preserved V;
- ValidateEvent for exact target proof after any required invalidation/barrier;
- value-scoped InvalidateEvent for persistent target stale state;
- WriterStateRecord when local allocation watermark changes.

A proof barrier for V does not taint another ValueId V2. True explicit invalidation remains node-wide.

Replicas need no shared canonical migration author; independent genuine replacements may later conflict/stale dependents normally.

## Atomic inactive-target cutover

Synchronization/reset/bootstrap/migration may build inactive target containing Journal, projection, metadata, derived indexes.

Only after validation/durable flush succeeds may active selection switch atomically. Failure leaves old supported active database selected; incomplete staging is disposable.

Canonical-artifact publication is one deliberate two-location bootstrap boundary: artifact may be durable before creator local cutover. Creator-resume makes that crash state recoverable without duplicate history.

## Projection rebuild

Projection rebuild is exclusive maintenance over fixed authoritative Journal state and may reconstruct graph/indexes without semantic authoring.

## Lock ordering/deadlock requirement

Journal 3 introduces no independent Journal mutex with arbitrary acquisition order. Implementations integrate publication into existing transaction/maintenance ownership with one documented order.

Optimizations may shorten exclusive windows but must not expose split Journal/projection state or finalize records from stale/unclosed causal frontier.