# Journal 3 User-Visible Operation Contract

## Purpose

Journal 3 is persistence/synchronization infrastructure, but callers need stable expectations around ordinary graph and lifecycle operations.

Raw Journal IDs/contexts/HLCs remain internal infrastructure rather than ordinary application API parameters.

## Ordinary graph APIs

Application code continues to use ordinary IncrementalGraph operations:

```text
pull(nodeName, bindings?)
invalidate(nodeName, bindings?)
inspection/read operations
```

### `pull()`

A successful pull has the existing IncrementalGraph semantic result. Any persisted graph change is committed together with replay-complete Journal history before success is observable.

Cases include fresh no-op, first materialization, changed recomputation, `Unchanged`, and cache revalidation.

### `invalidate()`

A successful explicit invalidation does not run target computor. It records node invalidation and actual propagated fresh->stale transitions while retaining safe cached `oldValue` state.

### Inspection

Inspection reads current materialized projection. It does not execute computors or author semantic Journal history merely because data was inspected.

## Synchronization

```text
synchronizeFrom(source)
```

requires an already-established writable receiver.

Successful pairwise synchronization means:

- compatibility came from same held stable snapshot as imported history;
- imported writer records keep exact identity/body;
- retained contexts/references are valid;
- required receiver normalization committed;
- active graph equals active Journal replay;
- no computor ran;
- repeating unchanged incorporated source is semantic no-op.

Synchronization may change selected value, identifier, presence, freshness, and validity through replay/normalization.

If selected occurrence is stale solely because a direct input is stale, synchronization persists that occurrence's stale flag even when newly imported/selected.

## Synchronization normalization is durable history

Sync may author real receiver:

- `DeleteEvent(reason="sync")` for structural cache removal;
- `InvalidateEvent(scope=value(V),reason="sync")` for persistent propagated staleness.

These are not acknowledgements. They remain ordinary semantic history.

## Synchronization failures

Failure before pairwise cutover leaves previous active pair supported. Multi-source outer operation may retain earlier successful pairwise commits if a later source fails.

Lifecycle callers can distinguish operational failure, compatibility failure, writer/bootstrap fork, malformed history, and projection failure.

## Absent-installation startup

A machine with **no local database/writer identity** first queries configured installation recovery source.

If synchronized state exists, receiver-less restore adopts snapshot `localWriter`, restores history/projection/allocator state, then runs migration gate. Query/read failure does not fall back to fresh identity. Only definite absence permits fresh creation.

## Same-writer Journal restoration

An existing Journal database behind its own writer history may import a longer agreeing exact prefix under maintenance and continue strictly after recovered head. Overlap disagreement is writer fork.

This differs from bootstrap creator-resume where state is still pre-Journal.

## Initial Journal bootstrap from legacy state

Pre-Journal replicas which will synchronize use one canonical semantic bootstrap cut as shared ValueId basis for occurrences equal to that cut.

Startup obtains cohort source result:

1. compatible immutable artifact -> creator-resume or ordinary join by fingerprint;
2. definite absence -> create canonical artifact and freeze before ordinary Journal authoring;
3. failure/indeterminate -> fail without competing history.

Artifact is original bootstrap target metadata plus records through creator frontier immediately after bootstrap. It does not advance with current cohort state.

A release joins only artifacts matching its expected supported bootstrap target. Old unsupported target -> `JournalVersionCompatibilityError` before authoring; permanent decoder/migration compatibility is not promised.

### Bootstrap does not run a legacy semantic migration first

The supported pre-Journal -> Journal bootstrap is graph-semantic identity over already-persisted legacy state.

At the canonical cut it preserves exact:

```text
materialized NodeKeys
NodeIdentifiers
payloads
createdAt / modifiedAt
freshness
validity
last_node_index
graph interpretation
```

Bootstrap does not first call ordinary migration `create`/`override`/`invalidate`/`delete` or synthesize wall-clock/allocator-dependent graph facts.

If a proposed bootstrap target requires such semantic migration, startup reports `JournalVersionCompatibilityError` before history is authored. Actual graph/schema migration occurs before entering a supported legacy source state or after bootstrap as Journal-aware migration.

### Creator resume after interrupted first bootstrap

If artifact exists and:

```text
artifact.creatorWriter == local DatabaseFingerprint
```

while local database remains pre-Journal, startup treats this as interrupted canonical creation.

It compares `project(artifact)` directly with persisted local legacy semantic graph under the identity-bootstrap rule. It does **not** rerun a migration callback or regenerate timestamps/identifiers.

Equal -> install exact artifact, rebuild writer head/allocator/high-water/projection, atomically cut over with no duplicate bootstrap history.

Different -> `JournalBootstrapForkError`. Another fingerprint cannot use creator-resume.

### Equal legacy occurrences and proof

If joining host has exact same occurrence as canonical cut, it reuses canonical ValueId and authors no replacement.

For that exact shared occurrence, join also does **not** author a causally-later validation merely to strengthen/replace canonical proof. Canonical proof remains basis.

Freshness is conservative:

```text
joined shared stale
    iff canonical stale OR joining stale
```

An uncovered value-scoped bootstrap marker is retained/authored when needed. Therefore a fresh joining copy cannot clear canonical stale state merely by upgrading later.

### Divergent legacy occurrences

A genuinely different local legacy occurrence becomes historical Journal evidence:

- authority seeded by persisted legacy `modifiedAt`;
- no synthetic happened-before from merely reading canonical artifact;
- normal concurrent-value authority decides conflict.

Upgrade time gives no precedence.

Two independent late joiners may hold same non-canonical occurrence and still assign different bootstrap ValueIds. Later synchronization may stale dependents naming loser. Accepted by `$id-1635227135166767`.

### Legacy absence/presence

Canonical-present/local-absent does not create deletion evidence. Local-only materialization may become historical joining occurrence.

### Bootstrap propagated stale state

After direct stale roots are represented, join propagates persistent stale markers through selected dependency DAG.

If selected K has complete own proof but a direct input is stale, bootstrap ensures `Invalidate(K,scope=value(currentValueId),reason=bootstrap)` exists unless already covered by an applicable marker.

Thus if joining stale input makes a canonical dependent recursively stale, later input `Unchanged` does not silently freshen dependent.

### After bootstrap

Installed pair is at supported bootstrap target. Startup then runs only Journal-aware migrations explicitly supported by running release. Post-bootstrap cohort history arrives later through ordinary compatible synchronization.

## Journal-aware migration

Database migration may rewrite every retained record representation into target current format while preserving IDs/historical meaning, then append only required semantic target changes.

### Canonical representation rewrite and `override()`

One pure per-record codec rewrites every affected retained ValueEvent identically across replicas, regardless of selected status.

`override()` preserves selected ValueId and only asserts callback result equals canonical rewritten payload. Mismatch fails before cutover. Semantic-changing override is invalid.

### Proof weakening versus explicit invalidation

A later partial certificate cannot always beat older stronger proof because replay prioritizes `basisMatchCount`.

If maintenance merely weakens proof for preserved occurrence V, migration uses:

```text
Invalidate(K,scope=proof(V),reason=migration)
```

before target validation. This makes older V certificates ineligible without invalidating proof for another occurrence V2.

If migration explicitly performs `invalidate(K)`, that remains a real node-scoped invalidation. The two semantics are intentionally different.

### Persistent target staleness

If target stores K stale while K's own selected proof is otherwise complete, migration ensures uncovered value-scoped invalidation targets final K ValueId even when recursive input staleness already makes replay stale.

Later upstream `Unchanged` does not freshen K until K itself validates/recomputes.

### Genuine new/replaced occurrences

New migration ValueEvent only for real create/replace occurrence.

Replicas may independently create different replacement ValueIds; later synchronization chooses normally and may stale dependents naming loser. This is accepted rather than requiring a specific coordinating peer.

Future replay never reruns historical migration callback.

## Reset

```text
resetTo(source)
```

requires established writable receiver and one held compatible source snapshot.

Reset retains source/receiver history and establishes source-target-equivalent projection relative to observed history.

Rules:

- matching target occurrence -> preserve ValueId;
- actual value-state difference -> new reset ValueEvent;
- weaker target proof for preserved V -> `proof(V)` barrier then exact target validation;
- proof barrier for V does not taint V2;
- target persistent stale with own proof complete -> value-scoped reset marker even if recursively stale already;
- target absence while union selects value -> one reset DeleteEvent;
- already-selected absence -> no redundant delete.

Reset records intentionally causally follow observed union. This is not bootstrap conflict semantics.

Repeated already-satisfied reset may return `changed=false`. No computor runs during reset.

## Projection rebuild

Administrative rebuild reconstructs derived graph/index state from authoritative current-format Journal history. Valid history rebuild is semantically invisible; malformed authoritative history causes failure rather than mutation of Journal to match graph bytes.

## No destructive compaction expectation

Journal 3 has no periodic destructive replay-history compaction obligation. Derived checkpoints/indexes may be added independently, but retained history remains authority.