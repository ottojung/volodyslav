# IncrementalGraph Journal 3 Locking and Atomic Publication

## Purpose

Journal 3 reuses the existing IncrementalGraph locking/publication model. It does not introduce an independent lock hierarchy.

The additional requirement is atomic consistency between authoritative Journal history and the materialized graph projection.

## Fundamental publication invariant

At every supported observable committed boundary:

```text
persistedGraph == project(retainedJournal)
```

No supported state exposes new Journal + old graph or old Journal + new graph.

## Ordinary graph operations

Ordinary `pull()`/`invalidate()` may compute before final publication, but exact Journal IDs/contexts/authority coordinates are finalized only inside the serialized commit boundary.

Finalization:

1. holds existing publication/darkroom protection;
2. observes the latest committed graph/Journal frontier;
3. reconciles the staged transition against committed state;
4. allocates one contiguous local-writer range;
5. orders records by semantic reference/dependency constraints;
6. assigns exact own-writer context and the closed observed cross-writer frontier;
7. allocates AuthorityTimes after causal predecessors;
8. atomically writes Journal records + graph mutations;
9. updates volatile allocator/index caches only after durable success.

A failed ordinary operation consumes no durable Journal coordinate.

## Context finalization

An ordinary event context represents complete semantic history observed by publication, not only explicitly referenced ValueIds.

Pre-Journal historical ValueEvent conversion is the narrow exception: physical reading of the canonical artifact during upgrade does not invent causal succession between two already-existing divergent legacy values.

## Same-publication ordering

Deterministic ordering extends semantic constraints: value before validation, referenced same-publication input before certificate, cause before propagated invalidation/deletion, and no forward reference.

## Existing graph telescope/nighttime behavior

Journal 3 does not weaken existing invalidation/recomputation race protection. Existing telescope/nighttime/darkroom rules determine the legitimate graph transition; Journal finalization records it.

## Synchronization

Synchronization may stream imported records into inactive staging. Before active publication it obtains exclusive maintenance ownership.

Receiver normalization is finalized after the imported frontier it normalizes. Imported records retain their original IDs, contexts, and authority.

### Same-writer-behind boundary

An ordinary `JournalSyncSource` may reveal that the receiver is behind its own writer stream. For example, receiver writer A may retain `A:1..900` while the source retains an agreeing `A:1..905`.

That observation is not sufficient authority to resume writer A. The source does not establish that 905 is continuation-safe under `database-lifecycle.md` §4.1.

Therefore ordinary synchronization does **not** activate a longer own-writer suffix and continue authoring merely because overlap agrees. It fails with `JournalWriterBehindError` and leaves the active receiver unchanged until `InstallationRecoverySource` establishes a continuation-safe A head. Divergent overlap is `JournalForkError`.

## Reset

Reset runs as exclusive maintenance, but it does not perform writer recovery inline.

If the held reset source is ahead for the receiver's own writer, reset fails `JournalWriterBehindError` before source import or reset authoring. Lifecycle recovery must establish a continuation-safe head first; reset may then be retried.

Once that precondition holds, reset stages only required Value/Delete/Validate/Invalidate records. Preserved ValueIds are not reallocated merely because reset is maintenance.

If target proof is weaker for preserved V, then for every currently effective incoming edge `D -> K` which the target removes, reset stages one edge-specific barrier:

```text
Invalidate(
    node=K,
    scope={kind:"proof", value:V, input:D},
    reason="reset"
)
```

before any target validation which re-proves retained edges. It does **not** use node scope merely as a certificate-selection barrier, and it does not retire unrelated proof edges for V.

If target stores persistent stale V while its own effective proof is otherwise complete, reset stages a value-scoped stale marker even when recursive input staleness already makes replay stale.

Reset-authored events causally follow the union they intentionally repair.

## Absent-installation restore

Receiver-less restore authors no semantic history merely to copy already-existing history. It atomically establishes local storage/projection and adopts the continuation-safe snapshot's `localWriter` before ordinary writes.

## Pre-Journal canonical bootstrap

The bootstrap gate first obtains the cohort-bootstrap-source decision:

- compatible immutable artifact -> creator-resume or ordinary join by local fingerprint;
- definite absence suitable for first creation -> canonical creation;
- indeterminate/error -> fail without bootstrap history.

A release which does not support the artifact target version/schema fails compatibility before staging.

### Bootstrap semantic-identity boundary

Bootstrap journals the **persisted legacy graph directly**. Before the canonical cut it does not run ordinary semantic migration decisions which create/delete/change graph semantics or synthesize wall-clock/allocator-dependent graph facts.

Thus canonical creation and creator-resume do not regenerate execution-dependent migration results. If actual graph/schema/representation migration is required, it runs only after Journal bootstrap as Journal-aware migration.

### Canonical creation and creator-resume crash window

The canonical artifact becomes durable before ordinary Journal authoring is enabled.

If artifact publication succeeds but creator local active cutover fails, restart may find pre-Journal local state plus the artifact with the same creator writer.

Creator-resume under exclusive maintenance:

1. compares the persisted legacy semantic graph directly with artifact projection; no migration callback reruns;
2. mismatch -> `JournalBootstrapForkError`, no active change;
3. match -> install the exact artifact stream/projection, reconstruct allocator/high-water/indexes, and cut over;
4. allocate no duplicate semantic records.

A different fingerprint cannot use this path.

### Ordinary bootstrap join

Join is not reset:

- an exact equal occurrence reuses canonical ValueId;
- a local-only/different occurrence becomes a historical joining ValueEvent using persisted legacy `modifiedAt`;
- a divergent value does not observe the canonical conflict solely because bootstrap read the artifact;
- canonical presence/local cache absence creates no delete;
- an exact shared occurrence retains the canonical certificate as its positive proof basis rather than receiving a joining-side validation merely to strengthen proof;
- for every canonical incoming edge absent from joining legacy proof, join stages one `proof(sharedV,input)` barrier so shared proof becomes the conservative intersection;
- an exact shared occurrence is persistently stale if either legacy side was stale;
- after direct stale roots, deterministic dependency-topological propagation adds value-scoped bootstrap markers for selected occurrences stale solely through stale inputs;
- WriterState preserves the local allocator watermark.

This ensures a fresh joiner cannot clear canonical stale state and an upstream `Unchanged` cannot later freshen a bootstrap-propagated stale dependent.

Two joiners may assign distinct ValueIds to the same non-canonical occurrence as accepted by `$id-1635227135166767`.

The complete bootstrap-target Journal/projection pair becomes active atomically. Onward semantic migration and post-bootstrap synchronization happen only afterward.

## Journal-aware migration

Migration may perform:

1. deterministic whole-history representation rewrite into an inactive target;
2. semantic target repair.

Representation rewrite preserves old IDs and allocates no new Journal positions.

One pure version codec rewrites every affected retained ValueEvent identically regardless of local selection. Representation-preserving selected state uses `keep`; the canonical codec is the sole source of target representation bytes.

The codec must be total over retained source-version history. If any retained record lacks a deterministic target representation, migration fails `JournalVersionCompatibilityError` before cutover.

Semantic migration may stage:

- ValueEvent for a genuine new/replaced occurrence;
- DeleteEvent for target absence;
- node-scoped InvalidateEvent for a true explicit migration `invalidate()`;
- one `proof(V,D)` barrier for every incoming edge D removed by maintenance-only proof weakening of preserved V;
- ValidateEvent for exact target proof when needed after required invalidation/barriers;
- value-scoped InvalidateEvent for persistent target stale state;
- WriterStateRecord when local allocation watermark changes.

A `proof(V,D)` barrier affects only edge D of occurrence V. Concurrent barriers for the same V compose by removing the union of the named edges; they do not erase unrelated proof or taint another ValueId V2. True explicit invalidation remains node-wide.

Replicas need no shared canonical migration author; independent genuine replacements may later conflict/stale dependents normally.

## Atomic inactive-target cutover

Synchronization/reset/bootstrap/migration may build inactive target state containing Journal, projection, metadata, and derived indexes.

Only after validation/durable flush succeeds may active selection switch atomically. Failure leaves the old supported active database selected; incomplete staging is disposable.

Canonical-artifact publication is one deliberate two-location bootstrap boundary: the artifact may be durable before creator local cutover. Creator-resume makes that crash state recoverable without duplicate history.

## Projection rebuild

Projection rebuild is exclusive maintenance over fixed authoritative Journal state and may reconstruct graph/indexes without semantic authoring.

## Lock ordering/deadlock requirement

Journal 3 introduces no independent Journal mutex with arbitrary acquisition order. Implementations integrate publication into existing transaction/maintenance ownership with one documented order.

Optimizations may shorten exclusive windows but must not expose split Journal/projection state or finalize records from a stale/unclosed causal frontier.
