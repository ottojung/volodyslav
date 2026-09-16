# Journal 3 User-Visible Operation Contract

## Purpose

Journal 3 is persistence/synchronization infrastructure, but callers need stable expectations around ordinary graph operations and lifecycle operations.

Raw Journal IDs/contexts/HLCs remain internal infrastructure rather than ordinary application API parameters.

## Ordinary graph APIs

Application code continues to use ordinary IncrementalGraph operations such as:

```text
pull(nodeName, bindings?)
invalidate(nodeName, bindings?)
inspection/read operations
```

### `pull()`

A successful pull has the semantic result required by existing IncrementalGraph contract.

If persisted graph state changes, replay-complete Journal history describing that state is committed atomically before success is observable.

Cases include:

- already-fresh no-op -> no semantic event required;
- first materialization -> new value occurrence + validation;
- changed recomputation -> new occurrence + validation + required propagated stale events;
- `Unchanged` -> preserve ValueId and append required validation;
- cache revalidation -> preserve ValueId and append proof needed to become fresh.

### `invalidate()`

A successful explicit invalidation does not run target computor.

It records enough history to reproduce target invalidation and actual propagated fresh->stale transitions while retaining safe cached `oldValue` state as required by existing graph contract.

### Inspection

Inspection reads current materialized projection. It does not execute computors or author semantic Journal records merely because data was inspected.

## Synchronization

Conceptually:

```text
synchronizeFrom(source)
```

requires an already-established writable receiver.

A successful pairwise synchronization means:

- source version/schema compatibility came from same held stable snapshot as imported history;
- every imported writer record retains original identity/body;
- all retained semantic-event contexts are valid causally closed cuts;
- required receiver normalization is committed;
- active graph equals replay of active Journal history;
- no computor ran;
- repeating against unchanged incorporated source is semantic no-op.

Synchronization may change current values, identifiers, presence, freshness, and validity through replay/normalization.

When selected current occurrence is stale solely because a direct input is stale, synchronization persists that exact occurrence's staleness even when occurrence was newly imported/selected.

Synchronization does not migrate record formats or infer provenance from payload equality.

## Synchronization normalization is durable semantic history

Synchronization may author real receiver events, principally:

- `DeleteEvent(reason="sync")` for structural cache removal; and
- value-scoped `InvalidateEvent(reason="sync")` for persistent propagated staleness.

Those are not temporary acknowledgements. Once committed, they remain historical facts and synchronize normally.

Convergence is required per actual fair execution rather than between counterfactual executions which actually authored different normalization events.

## Synchronization failures

Failure before pairwise cutover leaves previous active Journal/projection pair supported.

An outer operation may process several sources independently, so earlier successful pairwise commits may remain when a later source fails.

Lifecycle callers must be able to distinguish operational failure, compatibility failure, writer/bootstrap fork, malformed causal/reference history, and projection failure.

## Absent-installation startup

A machine with **no local database/writer identity** does not begin by creating a fresh fingerprint and ordinary-syncing.

Startup first queries configured recovery source for synchronized state belonging to this installation.

If it exists, receiver-less restoration performs `restoreAbsentFrom(source)`, adopts held snapshot's `localWriter`, restores retained history/projection/allocator state, and then runs normal migration gate if needed.

If recovery-source query/read fails, startup fails. Only definite absence permits genuine fresh creation.

## Same-writer Journal restoration

An existing Journal database merely behind its own writer history may import a longer agreeing exact prefix under exclusive maintenance.

After recovery, allocation continues strictly after recovered head. Any overlapping disagreement is writer fork.

This is distinct from bootstrap creator-resume, where local state is still pre-Journal and canonical artifact exists remotely/durably.

## Initial Journal bootstrap from legacy state

Pre-Journal replicas expected to synchronize after transition use one canonical semantic bootstrap **cut** as shared ValueId basis for occurrences equal to that cut.

Startup queries configured transport-neutral cohort bootstrap source:

1. compatible immutable artifact exists -> creator-resume or ordinary join depending on local fingerprint;
2. source definitively absent -> create canonical bootstrap and freeze artifact before ordinary Journal authoring;
3. query failed/indeterminate -> startup fails and does not create competing history.

Artifact is original bootstrap target version/schema plus exactly records through creator frontier immediately after bootstrap. It does not advance with current cohort state.

A running release may join artifact only when its expected bootstrap target exactly matches artifact version/schema. Journal 3 does not promise that arbitrary future releases retain historical bootstrap decoders or complete migration chains forever. For an unsupported old target, startup fails `JournalVersionCompatibilityError` before authoring; operator recovery uses software which explicitly supports that target first.

### Creator resume after interrupted first bootstrap

If artifact exists, local database is still pre-Journal, and:

```text
artifact.creatorWriter == local DatabaseFingerprint
```

this is an interrupted canonical creator, not an ordinary joining host.

Startup verifies `project(artifact)` equals local legacy graph interpreted at artifact target. If equal, it installs exactly artifact records, rebuilds writer head/allocator/high-water/projection, and atomically cuts over without creating duplicate bootstrap history.

If they differ, startup fails `JournalBootstrapForkError`. A different fingerprint cannot use creator-resume.

### Equal legacy occurrences

If ordinary joining host has same semantic occurrence as canonical cut, it reuses canonical ValueId and authors no local replacement.

### Divergent legacy occurrences

If joining host has genuinely different legacy occurrence, bootstrap converts it into historical Journal evidence rather than a new write performed “now.”

Local bootstrap ValueEvent:

- uses legacy occurrence's own `modifiedAt` to seed authority;
- does not claim canonical conflicting occurrence happened before it merely because migration code read artifact;
- competes with canonical occurrence through normal concurrent-value Journal authority.

A newer canonical legacy occurrence beats older late-host occurrence; newer late-host occurrence may beat canonical one. Upgrade time gives no precedence.

Two independent late joiners may hold the same occurrence which differs from canonical cut and nevertheless create different bootstrap ValueIds for it. Later synchronization may stale dependents naming losing occurrence. This is accepted by `$id-1635227135166767`; bootstrap does not add another pre-Journal identity-reconciliation protocol.

### Legacy absence/presence

A node present in canonical cut but absent from one legacy host is not deleted merely to recreate that host's old cache. Pre-Journal absence is not deletion evidence.

A node present only on late legacy host may be converted into local historical bootstrap occurrence.

### After bootstrap

Installed database is at artifact's bootstrap target version. Startup may continue through whatever Journal-aware migration steps running release explicitly supports. Only after reaching compatible current version may ordinary synchronization import post-bootstrap cohort history.

Thus if canonical K=v1 later became K=v2 while host was offline with v1, supported late host reuses canonical v1 at bootstrap and later learns v2 through ordinary sync; it does not roll cohort back by re-authoring v1 as causally newer.

## Journal-aware migration

A database migration may rewrite physical representation of every retained Journal record into target current format while preserving record IDs and historical meaning.

Semantic migration then applies only target changes actually required.

### Canonical representation rewrite

When retained `ComputedValue` representation changes, one pure per-record version codec determines target representation of every affected historical ValueEvent.

Same old JournalRecordId is rewritten identically on every replica regardless of whether occurrence is currently selected there.

### `keep`

`keep` preserves semantic occurrence and selected ValueId.

### `override()`

`override()` is semantic-preserving representation decision. It preserves selected ValueId even when target-version stored representation changes.

For Journal-aware migration, callback does not independently determine bytes of retained historical ValueEvent. Its result must equal canonical per-record rewrite of selected record. If not, migration fails before cutover.

`override()` must not be used when semantic value changes.

### Proof weakening

Migration can preserve a ValueId while intentionally removing incoming validity proof—for example explicit `invalidate(K)` or stale `keep`/`override` behavior.

A later partial certificate alone cannot necessarily remove old proof because replay prefers greater `basisMatchCount` before authority.

Therefore migration first authors a node-scoped proof barrier when target validity removes any currently-valid incoming edge. Older certificates predating barrier become ineligible; target validation after barrier can establish exact weaker proof.

### Persistent target staleness

If target stores K stale while K's own selected proof is otherwise complete and covers its current-value invalidations, migration ensures an uncovered value-scoped invalidation targets final K ValueId even when K is already stale recursively because an input is stale.

This keeps migration-propagated stale flag persistent: later upstream `Unchanged` does not freshen K until K itself validates/recomputes.

### Genuine new/replaced occurrences

New migration ValueEvent is authored only when migration actually creates/replaces semantic occurrence.

Journal-aware migrations may run independently on different replicas. If two replicas independently create distinct ValueIds for genuine replacement, ordinary synchronization later chooses by conflict authority; dependents whose certificates name losing replacement may become stale/recompute. This is accepted rather than requiring particular peer coordination.

Future replay never reruns historical migration callback.

## Reset

Conceptually:

```text
resetTo(source)
```

requires established writable receiver and one held compatible source snapshot.

Reset retains receiver/source history and makes receiver projection source-target-equivalent relative to all observed history.

Reset is minimal by semantic layer:

- if union already selects requested immutable value occurrence, preserve its ValueId;
- if value state differs, author new reset ValueEvent;
- if target validity removes any current edge, first author node-scoped reset proof barrier, then establish exact target certificate;
- if target adds/changes proof without weakening, author required validation without unnecessary ValueEvent;
- if target stores K stale while K's own proof is complete, ensure an uncovered value-scoped reset invalidation for final K ValueId even if recursive replay is already stale through input;
- if target requires absence while union selects value, author exactly one reset DeleteEvent;
- if target absence already selected, author no redundant delete.

Consequently a reset-stale dependent does not become fresh merely because upstream input later returns `Unchanged`.

Reset records are intentionally causally later than observed union they repair. This semantic is **not** used to import divergent pre-Journal legacy values during bootstrap.

Repeated reset to unchanged already-satisfied target may return `changed=false` and author nothing.

No computor runs during reset.

## Projection rebuild

An administrative rebuild may discard/reconstruct derived graph/index state from authoritative current-format Journal history.

For valid history, successful rebuild is semantically invisible to ordinary callers.

If authoritative Journal history itself is malformed—writer fork, non-transitively-closed context, impossible ValueId reference—rebuild fails instead of changing history to match graph bytes.

## No destructive compaction expectation

Journal 3 has no periodic destructive history-compaction obligation.

Derived checkpoints/indexes may be added independently, but replay/debug history remains authoritative and retained.
