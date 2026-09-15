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

A successful pull has the same semantic result required by the existing IncrementalGraph contract.

If persisted graph state changes, replay-complete Journal history describing that state is committed atomically before success is observable.

Cases include:

- already-fresh no-op -> no semantic event required;
- first materialization -> new value occurrence + validation;
- changed recomputation -> new occurrence + validation + required propagated stale events;
- `Unchanged` -> preserve ValueId and append required validation;
- cache revalidation -> preserve ValueId and append proof needed to become fresh.

### `invalidate()`

A successful explicit invalidation does not run the target computor.

It records enough history to reproduce target invalidation and actual propagated fresh->stale transitions while retaining safe cached `oldValue` state as required by the existing graph contract.

### Inspection

Inspection reads the current materialized projection. It does not execute computors or author semantic Journal records merely because data was inspected.

## Synchronization

Conceptually:

```text
synchronizeFrom(source)
```

requires an already-established writable receiver.

A successful pairwise synchronization means:

- source version/schema compatibility came from the same held stable snapshot as imported history;
- every imported writer record retains its original identity/body;
- all retained semantic-event contexts are valid causally closed cuts;
- required receiver normalization is committed;
- active graph equals replay of active Journal history;
- no computor ran;
- repeating against the unchanged incorporated source is a semantic no-op.

Synchronization may change current values, identifiers, presence, freshness, and validity through replay/normalization.

When the selected current occurrence is stale solely because a direct input is stale, synchronization persists that exact occurrence's staleness even when the occurrence was newly imported/selected.

Synchronization does not migrate record formats or infer provenance from payload equality.

## Synchronization normalization is durable semantic history

Synchronization may author real receiver events, principally:

- `DeleteEvent(reason="sync")` for structural cache removal; and
- value-scoped `InvalidateEvent(reason="sync")` for persistent propagated staleness.

Those are not temporary acknowledgements. Once committed, they remain historical facts and synchronize normally.

Convergence is therefore required per actual fair execution rather than between counterfactual executions which actually authored different normalization events.

## Synchronization failures

Failure before pairwise cutover leaves the previous active Journal/projection pair supported.

An outer operation may process several sources independently, so earlier successful pairwise commits may remain when a later source fails.

Lifecycle callers must distinguish operational failure, compatibility failure, writer fork, malformed causal/reference history, and projection failure.

## Absent-installation startup

A machine with no local database/writer identity does not begin by creating a fresh fingerprint and then ordinary-syncing.

Startup first queries the configured recovery source for synchronized state belonging to this installation.

If it exists, receiver-less restoration conceptually performs `restoreAbsentFrom(source)`, adopts the held snapshot's `localWriter`, restores retained history/projection/allocator state, and then runs the normal migration gate if needed.

If the recovery-source query/read fails, startup fails. Only definite absence permits genuine fresh creation.

## Same-writer restoration of an existing database

An existing local database which is merely behind its own writer history may import a longer agreeing exact prefix under exclusive maintenance.

After recovery, allocation continues strictly after the recovered head. Any overlapping disagreement is a writer fork.

## Initial Journal bootstrap from legacy state

Pre-Journal replicas expected to synchronize after transition use one canonical semantic bootstrap history as a shared ValueId basis.

Before choosing create versus join, startup queries the configured transport-neutral **cohort bootstrap source**:

1. canonical source exists -> join it;
2. source definitively absent -> create the canonical bootstrap;
3. query failed/indeterminate -> startup fails and does not create competing history.

A joining host does not need an exactly equal legacy graph. It retains canonical records verbatim, then authors under its own writer only the minimal `reason="bootstrap"` delta needed to reproduce its local supported legacy graph.

Therefore:

- nodes whose immutable semantic occurrence fields match the canonical projection retain the canonical ValueIds;
- a locally changed node gets a joining-writer ValueEvent only for that changed occurrence;
- local presence/absence differences use minimal Value/Delete records;
- validity/freshness-only differences use Validate/Invalidate without replacing equal occurrences;
- the joining host keeps its own writer fingerprint and allocator watermark.

This lets an offline host preserve legitimate legacy changes while still sharing occurrence identity for all unaffected state.

If the bootstrap-source query is indeterminate, the host fails rather than racing another canonical creator. Distinct canonical histories for one cohort are unsupported.

## Journal-aware migration

A database migration may rewrite the physical representation of every retained Journal record into the target current format while preserving record IDs and historical meaning.

Semantic migration then applies only target changes actually required.

### `keep`

`keep` preserves the semantic occurrence and selected ValueId.

### `override()`

`override()` is a semantic-preserving representation rewrite. It preserves the selected ValueId even when the target-version stored payload representation changes.

The payload-representation conversion belongs to the deterministic whole-history representation rewrite. The selected `ValueEvent` keeps its JournalRecordId, semantic meaning, NodeIdentifier, createdAt, and modifiedAt.

Two replicas independently performing the same representation-only override therefore keep the same pre-migration ValueId shared.

`override()` must not be used when the semantic value changes; the existing migration contract requires invalidation/recomputation or another explicit semantic replacement for that case.

### Proof/freshness changes

Schema/proof/freshness changes alone do not manufacture a replacement value occurrence. Migration may append Validate/Invalidate records targeting a preserved ValueId.

### Genuine new/replaced occurrences

A new migration ValueEvent is authored only when migration actually creates/replaces the semantic occurrence.

Journal-aware migrations may run independently on different replicas. If two replicas independently create distinct ValueIds for a genuine replacement, ordinary synchronization later chooses by conflict authority; dependents whose certificates name a losing replacement may become stale and recompute/revalidate. This is accepted rather than requiring a particular peer to coordinate migration.

Future replay never reruns the historical migration callback.

## Reset

Conceptually:

```text
resetTo(source)
```

requires an established writable receiver and one held compatible source snapshot.

Reset retains receiver/source history and makes the receiver projection source-target-equivalent relative to all observed history.

Reset is minimal by semantic layer:

- if the union already selects the requested immutable value occurrence, preserve its ValueId;
- if value state actually differs, author a new reset ValueEvent;
- if only proof differs, author the required ValidateEvent;
- if only freshness differs, use the required value-scoped InvalidateEvent or later validation;
- if target requires absence while union selects a value, author exactly one reset DeleteEvent;
- if target absence is already selected, author no redundant delete.

Repeated reset to an unchanged already-satisfied target may return `changed=false` and author nothing. No computor runs during reset.

## Projection rebuild

An administrative rebuild may discard/reconstruct derived graph/index state from authoritative current-format Journal history.

For valid history, successful rebuild is semantically invisible. If authoritative history is malformed, rebuild fails rather than changing history to match graph bytes.

## No destructive compaction expectation

Journal 3 has no periodic destructive history-compaction obligation.

Derived checkpoints/indexes may be added independently, but replay/debug history remains authoritative and retained.