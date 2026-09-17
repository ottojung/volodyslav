# Journal 3 User-Visible Operation Contract

## Purpose

Journal 3 is persistence/synchronization infrastructure. Ordinary callers continue to see IncrementalGraph operations rather than raw Journal IDs, contexts, authority clocks, or writer coordinates.

## Ordinary graph APIs

### `pull()`

A successful pull has the existing IncrementalGraph result. Any persisted graph transition and its replay-complete Journal history become durable together.

Fresh no-op, first materialization, changed recomputation, `Unchanged`, and cache revalidation remain ordinary graph behavior.

### `invalidate()`

Explicit invalidation runs no target computor. It records genuine node invalidation and the actual persistent fresh->stale propagation while retaining cached values which remain safe as `oldValue`.

### Inspection

Inspection reads current materialized projection. It does not execute computors or author semantic history merely because data was read.

## Synchronization

```text
synchronizeFrom(source)
```

requires an established writable receiver.

Success means:

- version/schema compatibility came from the same immutable source snapshot as imported history;
- imported foreign records kept exact identity/body;
- causal/reference rules were validated;
- required receiver normalization committed;
- active graph equals active Journal replay;
- no computor ran; and
- repeating the same incorporated source without intervening changes is a semantic no-op.

### Keep versus delete under merged dependency state

Journal 3 no longer uses input-count/arity as a proxy for whether a cached dependent is safe.

- If a selected cached node loses a required materialized input, synchronization explicitly deletes that dependent closure. The node cannot remain materialized under IncrementalGraph structural semantics.
- If every required input remains present, disagreement between current input ValueIds and the dependent's certificate does **not** by itself delete the cached value. The cache remains a legitimate `oldValue`; replay expresses hard/soft stale state through proof/freshness.

So mixed input histories affect validity/freshness, not cache existence, unless structural dependency closure itself fails.

### Persistent propagated stale state

If a selected occurrence has complete **effective** own proof but is stale because an input is stale, sync persists `Invalidate(scope=value(currentValueId), reason="sync")`, including when that occurrence was newly selected from the source. Later upstream `Unchanged` cannot freshen the dependent automatically.

## Synchronization can reveal unsafe writer rollback

If an ordinary source contains a longer prefix of the receiver's **own** local writer, ordinary sync does not adopt that suffix and continue authoring.

It fails `JournalWriterBehindError` and requires same-writer recovery through an `InstallationRecoverySource` which can establish a continuation-safe head. A generic peer may prove that the receiver is behind, but merely appearing newest does not itself prove that no older higher record can later re-enter under the supported backend model.

## Absent-installation startup

A machine with no local database/writer identity queries an installation recovery source **before** generating a fresh fingerprint.

- continuation-safe synchronized state exists -> restore that writer/history/projection/allocator state;
- definite absence -> fresh identity may be created;
- read/query/continuation-safety uncertainty -> fail, no fresh fallback.

For writer A at recovered head q, continuation-safe means that after recovery no previously authored `A:r` with `r > q` can later enter supported retained history. The persistence/recovery implementation may rely on guarantees of its supported backend model to establish this and need not account for hypothetical copies that cannot arise or later re-enter under that model. Records lost only with local storage and unable to re-enter do not make q unsafe.

The recovery source abstraction does not require one server, one branch, one authority, or one storage topology. Transport locators such as hostnames or branch names remain outside IncrementalGraph-owned persisted state and semantic recovery APIs.

## Existing-writer recovery

A behind existing installation may resume its writer only from a continuation-safe recovery snapshot whose local writer is the same writer and whose stream extends the local stream by an exact prefix.

Recovery imports the missing own-writer suffix plus required causal history, reconstructs allocator/high-water/projection, and only then permits another local record after the continuation-safe recovered head. Divergent overlap is a writer fork.

## Initial Journal bootstrap

Pre-Journal replicas which will later synchronize use one frozen canonical bootstrap cut as the shared ValueId basis for occurrences equal to that cut.

The cohort source yields exactly:

```text
Exists(CanonicalBootstrapSnapshot)
DefinitelyAbsent
IndeterminateOrError
```

Indeterminate/error does not authorize competing canonical creation.

The artifact contains exactly the original bootstrap frontier/version/schema, not later cohort history.

### Bootstrap is semantic identity

Bootstrap journals the already-persisted supported legacy graph. Before Journal identity exists it does not run ordinary semantic migration decisions such as `create`/`invalidate`/`delete`, synthesize new timestamps/identifiers, or perform a schema-semantic migration.

If such a migration is required, the automatic bootstrap transition is incompatible. Actual graph/schema/representation migration happens before entering the supported legacy source state or afterward as Journal-aware migration.

### Creator resume

If the canonical artifact belongs to the still-pre-Journal local fingerprint, startup resumes the interrupted creator transition: direct persisted legacy state must equal artifact projection. On equality install exactly the artifact and reconstruct writer state; on disagreement fail `JournalBootstrapForkError`. No migration callback reruns and no duplicate bootstrap history is authored.

### Exact shared occurrence

If joining legacy host has exactly the canonical occurrence, it reuses the canonical ValueId.

Positive proof merges conservatively:

```text
joinedValid = canonicalValid intersect joiningValid
```

Canonical certificate remains the positive basis. For every canonical incoming edge missing from joining legacy proof, join authors `proof(V,D)` negative edge evidence. Joining-only proof never strengthens the exact shared occurrence merely because that host upgrades later.

Freshness is likewise conservative:

```text
joinedStale = canonicalStale OR joiningStale
```

After proof-edge barriers, an uncovered `value(V)` bootstrap marker is retained/authored whenever either side was stale.

### Divergent values and legacy absence

A different/local-only legacy occurrence becomes historical concurrent bootstrap evidence with authority seeded from persisted legacy `modifiedAt`, not upgrade time.

Canonical-present/local-absent does not manufacture a deletion. Two independent late joiners may assign different ValueIds to the same non-canonical legacy occurrence; `$id-1635227135166767` accepts the resulting possible downstream recomputation.

### Recursive bootstrap staleness

After direct proof/stale evidence is represented, bootstrap walks the selected DAG. If selected K's effective own proof is complete but an input is stale, it persists `value(currentValueId(K))` stale history so later upstream `Unchanged` cannot silently freshen K.

## Journal-aware migration

Migration has two distinct parts:

1. deterministic whole-history format rewrite;
2. semantic target repair.

### Representation rewrite

One canonical transform rewrites **every retained source-format record**, including history for node families absent from the target schema. If no deterministic target representation exists for some retained record, migration fails `JournalVersionCompatibilityError` before cutover.

When ValueEvent payload representation changes, one pure per-record codec is the sole source of target bytes across all replicas and all selected/historical occurrences. A selected semantic occurrence whose meaning survives uses `keep`.

### Semantic occurrence identity

Occurrence-preserving decisions (`keep`, `invalidate`, proof/freshness/schema-only changes, representation-only format rewrite) preserve the ValueId. A new ValueEvent is reserved for actual create/replace occurrence changes.

Independent genuine replacement migrations may create different replacement ValueIds; later synchronization selects normally and may stale dependents naming a losing replacement. This is accepted.

### Proof weakening

True migration `invalidate(K)` remains node-scoped.

If maintenance merely removes incoming validity while preserving V, it authors one:

```text
Invalidate(K, scope=proof(V,D), reason=migration)
```

for each removed edge `D -> K`.

A proof-edge barrier removes only that edge from certificates targeting V until causally re-proved. Concurrent barriers compose by subtracting the union of named edges; they do not destroy unrelated proof or affect V2.

### Persistent target stale state

If the target stores K stale while K's own effective proof is complete, migration persists a `value(V)` stale marker even when K is already recursively stale through an input. Later upstream `Unchanged` does not freshen K until K itself validates/recomputes.

## Reset

```text
resetTo(source)
```

requires an established writable receiver and one held compatible source snapshot.

If the reset source is ahead for the receiver's own local writer, reset fails `JournalWriterBehindError` before importing or authoring anything. The lifecycle must establish a continuation-safe writer head through `recoverExistingWriterFrom(InstallationRecoverySource)` before reset is retried.

Reset retains history and establishes the source projection relative to all history it observed.

- matching target occurrence -> preserve ValueId;
- actual occurrence difference -> new reset ValueEvent;
- each removed proof edge for preserved V -> `proof(V,D)` barrier;
- exact target proof -> validation as needed;
- target persistent stale with effective own proof complete -> `value(V)` reset marker;
- target absence while union selects value -> one DeleteEvent;
- already-selected absence -> no redundant delete.

Reset repairs intentionally causally follow observed history. That causal-later semantics is not used for pre-Journal bootstrap conflicts.

## Projection rebuild

Administrative rebuild reconstructs graph/index state from authoritative current-format Journal history. Valid history rebuild is semantically invisible. Malformed authoritative history causes failure rather than rewriting Journal to match graph bytes.

## History retention

Journal 3 has no destructive replay-history compaction obligation. Derived indexes/checkpoints may be added independently, but retained Journal history remains semantic authority.
