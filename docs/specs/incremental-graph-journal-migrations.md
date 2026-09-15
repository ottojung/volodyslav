# IncrementalGraph Journal 3 Bootstrap and Migration

## Purpose

This document specifies:

1. initial bootstrap from a supported pre-Journal-3 IncrementalGraph database into replay-complete Journal 3 history; and
2. later database/schema migration when the input already contains Journal 3 history.

Both preserve:

```text
persistedGraph == project(retainedJournal)
```

The central identity rule is:

> migration must not manufacture a new ValueId merely because the database version, schema, proof state, or freshness changed. A new ValueEvent is required only when the semantic value occurrence itself is replaced/created.

That rule prevents version transitions from gratuitously destroying shared occurrence identity and then making otherwise-valid downstream certificates disagree after replicas synchronize.

## Relationship to the existing migration framework

The existing migration framework decides the target IncrementalGraph state: values may be kept/replaced/created/deleted/invalidated and relowered under a new schema according to `migration.md`.

Journal 3 adds two responsibilities:

```text
source replica
    -> deterministically rewrite retained journal representation
       into the target database format
    -> controlled migration computes target graph
    -> append only the semantic records required to establish that target
    -> verify target replay
    -> atomically cut over
```

Representation migration changes how already-existing historical records are stored, not what historical facts their IDs denote.

Semantic migration records only actual target-state changes/proof changes. Future replay never reruns the old migration callback.

## One-format migration invariant

The active source replica is interpreted entirely according to its source `global/version`.

The inactive target replica is constructed entirely according to the target `global/version`.

No active or completed target replica may contain a mixture of source-format and target-format journal records. Journal records have no independent `recordVersion` field and ordinary replay has no per-record upcast/downcast path.

## Representation rewrite contract

For every existing source journal record:

```text
Rsource with id = (A,q)
```

format migration produces exactly one target-format record:

```text
Rtarget with id = (A,q)
```

such that:

- the `JournalRecordId` is unchanged;
- the historical semantic fact denoted by the record is unchanged;
- semantic causal context and authority meaning are unchanged;
- every `ValueId`/record reference continues to name the same journal identity;
- writer-stream sequence/contiguity is unchanged.

The rewrite is canonical and deterministic. Given the same source-version record and the same source->target migration definition, independently migrating replicas must produce the same target-format record.

If application/schema semantics change, that change is represented by newly appended migration events. It must not be smuggled into the rewritten meaning of an old record.

## Whole-journal rewrite trade-off

A format-changing migration may inspect/rewrite every retained record before cutover. Time and I/O proportional to retained journal size are accepted. The rewrite should still be streamable where practical.

## Common preconditions

Migration input must satisfy the source-version invariants it claims.

For a legacy graph being converted into Journal 3 this includes at least:

- expected shared materialized key sets for identifiers/values/freshness/timestamps;
- dependency closure under the source schema;
- structurally sound validity edges;
- complete incoming validity for fresh nodes;
- parseable timestamps with `createdAt <= modifiedAt`;
- valid local `last_node_index`.

For Journal-3-aware input, source journal streams must additionally be valid under the source database format, including transitively closed event contexts.

Malformed state is rejected rather than converted into history that merely makes corruption self-consistent.

# Part I: initial pre-Journal-3 bootstrap

## Goal

Given one supported canonical legacy graph Glegacy with no Journal 3 history, construct Jbootstrap directly in the target current format such that:

```text
project(Jbootstrap) == Glegacy
```

without changing graph semantics merely to accommodate journaling.

## Why bootstrap must be canonical across a synchronization cohort

Two legacy replicas may already represent the **same shared cached occurrence** but have no ValueId because ValueIds did not exist before Journal 3.

If each host independently minted its own bootstrap ValueIds, later synchronization could select an input occurrence from one host and a dependent occurrence from another. The dependent certificate would then point at the losing bootstrap ValueId even though the legacy graph had been mutually valid before upgrade.

Therefore replicas expected to synchronize after the transition must not independently mint semantic bootstrap histories for equivalent shared legacy state.

A synchronization cohort uses one **canonical bootstrap history**.

This is a migration/lifecycle rule, not a transport protocol. How the configured lifecycle chooses/carries the canonical bootstrap source is outside Journal semantics.

## Preparing the canonical legacy state

Before the cohort crosses the Journal-3 boundary, any legacy changes that must survive the transition must be reconciled using the supported pre-Journal-3 synchronization behavior while compatible legacy software/state is still available.

The canonical bootstrap source must represent the legacy state chosen for the transition.

A legacy installation whose local graph is not observationally equivalent to that canonical legacy state must not silently perform an independent Journal-3 bootstrap and later rely on normal Journal synchronization to reconcile the artificial ValueId divergence.

It must instead do one of:

- reconcile its intended legacy changes before the Journal-3 transition;
- explicitly discard/rebaseline those local legacy differences to the canonical bootstrap state; or
- fail the automatic migration and require an explicitly specified recovery/import transition.

Journal 3 does not invent a hidden payload-equality merge to recover independently-created bootstrap identities later.

## Canonical bootstrap writer

The installation which creates the canonical semantic bootstrap uses its existing durable `DatabaseFingerprint` as JournalAuthor.

Its journal stream starts at zero and authors the semantic baseline below.

Other installations in the cohort retain these exact semantic bootstrap records; they do not re-author equivalent ValueEvents/ValidateEvents under their own writers.

## Bootstrap authority for value occurrences

Bootstrap ValueEvents use:

```text
authorityTime = {
    physical: canonical(modifiedAt),
    logical: 0
}
```

and are allocated in nondecreasing `(modifiedAt, canonical NodeKey)` order.

This avoids making equal-time bootstrap precedence depend on unrelated enumeration depth.

After all bootstrap ValueEvents, ordinary HLC allocation resumes for validation/invalidation events with high-water raised to at least the greatest bootstrap value authority.

## Bootstrap Pass 1: value occurrences

For every materialized legacy node K in deterministic `(modifiedAt, canonical NodeKey)` order, author:

```text
ValueEvent {
    node: K,
    nodeIdentifier: legacy node identifier,
    payload: legacy values[K],
    createdAt: canonical legacy createdAt,
    modifiedAt: canonical legacy modifiedAt,
    reason: "bootstrap",
    authorityTime: { physical: modifiedAt, logical: 0 }
}
```

Record its ID as:

```text
bootstrapValueId(K)
```

All bootstrap ValueEvents are created before bootstrap validation events.

## Bootstrap Pass 2: validation baseline

For every materialized K, let:

```text
inputSet(K) = set(inputEdges(K))
```

under the legacy/bootstrap schema.

Author:

```text
ValidateEvent {
    node: K,
    value: bootstrapValueId(K),
    reason: "bootstrap",
    basis: [
        {
            input: D,
            value: bootstrapValueId(D) | "unknown"
        },
        ...
    ]
}
```

with exactly one entry per direct input D, in canonical persisted NodeKey order.

Use `bootstrapValueId(D)` when the legacy `valid[D]` contains K, otherwise `"unknown"`.

A fresh node therefore has a complete current basis. A stale node reproduces its exact retained partial validity without inventing pre-Journal historical occurrences.

## Bootstrap Pass 3: stale state

For every legacy stale K, author:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "value", value: bootstrapValueId(K) },
    reason: "bootstrap"
}
```

after its bootstrap certificate.

## Bootstrap Pass 4: canonical writer allocation state

The canonical bootstrap writer records its own legacy allocation watermark with a `WriterStateRecord`.

## Joining the canonical bootstrap from another legacy installation

Another installation in the same cohort keeps its **own** existing `DatabaseFingerprint`; it must not clone the canonical source's local writer identity.

To join the canonical bootstrap automatically:

1. validate that its legacy semantic graph is observationally equivalent to the canonical bootstrap projection for materialization, NodeIdentifiers, payloads, timestamps, freshness, and validity;
2. retain the canonical bootstrap journal records verbatim;
3. set `localWriter` to the joining installation's existing fingerprint;
4. append only the joining writer's required `WriterStateRecord` preserving its own legacy `last_node_index` when that writer state is not already represented;
5. materialize `project(canonicalJournal, localWriter=joiningFingerprint)` and atomically cut over.

The joining installation does **not** mint a second semantic bootstrap baseline.

This preserves shared ValueIds across the cohort while preserving each installation's local allocation namespace.

If the legacy graph equivalence check fails, automatic join fails rather than creating competing bootstrap identities.

## Absent legacy nodes

Bootstrap does not manufacture DeleteEvents for arbitrary unmaterialized keys. Its initial semantic domain is the finite state represented by the chosen legacy graph.

## Bootstrap postcondition

The canonical semantic bootstrap satisfies:

```text
semanticGraph(project(Jbootstrap)) == semanticGraph(Glegacy)
```

and each joining installation additionally reconstructs its own local allocator watermark from its own WriterStateRecord.

# Part II: Journal-3-aware migration

## Principle

A later migration starts from:

```text
Gbefore = project(Jbefore, sourceSchema)
```

rewrites retained history into the target representation:

```text
Jconverted = rewriteJournalFormat(Jbefore, sourceVersion, targetVersion)
```

and computes target graph:

```text
Gtarget
```

under the target schema/version.

The semantic migration then appends only the records required so that:

```text
project(Jafter, targetSchema) == Gtarget
```

where:

```text
Jafter = Jconverted + migration-authored records
```

## Preserve value occurrence identity whenever the value is preserved

For every node K present before and after migration, distinguish **value occurrence state** from proof/freshness state.

The selected ValueId is preserved when the migration policy keeps the same semantic cached occurrence. In particular, schema change, validation change, or invalidation/freshness change alone does not create a new ValueEvent.

A migration may preserve the source ValueId only when the target keeps that occurrence's immutable value fields:

```text
nodeIdentifier
payload
createdAt
modifiedAt
```

The migration framework's explicit keep/invalidate disposition is the authority for that decision; ordinary synchronization must not infer it later from payload equality.

A new migration ValueEvent is required only when migration:

- creates a previously absent materialization;
- replaces/transforms the cached value occurrence;
- changes the selected NodeIdentifier;
- changes the occurrence's persisted payload/timestamps; or
- otherwise explicitly defines a new semantic occurrence.

## Canonical semantic migration across a synchronization cohort

A semantic migration which creates new ValueEvents can otherwise reproduce the same artificial cross-host occurrence split as independent bootstrap.

Therefore a synchronization cohort must use one canonical semantic migration result for a given source->target version transition when that transition creates/replaces semantic value occurrences.

Before that transition, changes which must survive should be reconciled while peers still share the compatible source version. The canonical migration source then produces the semantic migration records once; other cohort members deterministically rewrite their shared retained old records and retain the canonical semantic migration records rather than independently minting equivalent new ValueIds.

Peers which cannot establish the required compatible source state must not silently create an independent equivalent-looking semantic baseline. They require an explicit recovery/reset/import decision.

A migration which performs only canonical representation rewrite and preserves every selected value occurrence may be carried out independently, because shared pre-migration ValueIds remain shared. New proof records may be independently authored only when doing so cannot create new value occurrence identity; normal certificate selection then handles those proofs deterministically.

This rule is transport-neutral and does not prescribe Git/backend behavior.

## Migration observation cut

The semantic migration observes one complete source frontier:

```text
Fmigrate = frontier(Jbefore) = frontier(Jconverted)
```

Every migration-authored semantic event is causally after that closed frontier plus earlier same-migration records it references.

## Migration target domain

Let:

```text
BeforePresent = present keys in Gbefore
TargetPresent = present keys in Gtarget
MigrationDomain = BeforePresent union TargetPresent
```

A key absent before and after needs no event solely because historical records exist.

## Migration Pass 1: establish target value/absence heads

For every K in TargetPresent:

### Preserved occurrence

If migration keeps the same occurrence, define:

```text
targetValueId(K) = valueId_Gbefore(K)
```

and author no ValueEvent for K.

### New/replaced occurrence

Otherwise author:

```text
ValueEvent {
    node: K,
    nodeIdentifier: Gtarget.nodeIdentifier(K),
    payload: Gtarget.payload(K),
    createdAt: Gtarget.createdAt(K),
    modifiedAt: Gtarget.modifiedAt(K),
    reason: "migration"
}
```

and define its ID as `targetValueId(K)`.

For every K in `BeforePresent - TargetPresent`, author exactly one required:

```text
DeleteEvent {
    node: K,
    reason: "migration"
}
```

unless the converted history already selects absence after all migration-observed history. The rule is deterministic: no delete is emitted for a node already absent in the migration observation cut; a delete is emitted when a selected source value must become target absence.

## Migration Pass 2: target proof baseline

Proof state is independent from value occurrence identity.

After every `targetValueId(K)` is known, migration MAY reuse an existing eligible current-shape certificate only when replay under the target schema already yields exactly Gtarget's validity for K and the certificate covers the migration-observed node/value invalidations required for the target state.

Otherwise author one migration `ValidateEvent` targeting the preserved-or-new `targetValueId(K)`:

```text
ValidateEvent {
    node: K,
    value: targetValueId(K),
    reason: "migration",
    basis: [
        {
            input: D,
            value: targetValueId(D) | "unknown"
        },
        ...
    ]
}
```

with one entry for every target direct input D in canonical NodeKey order.

Use `targetValueId(D)` exactly when Gtarget contains validity edge `D -> K`; otherwise use `"unknown"`.

This allows schema/proof migration to create a new certificate for an existing ValueId without pretending the value itself changed.

## Migration Pass 3: target freshness

After target proof selection:

- if Gtarget says K is fresh and the selected certificate already yields fresh replay, author no invalidation;
- if Gtarget says K is stale and replay would otherwise be fresh, author:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "value", value: targetValueId(K) },
    reason: "migration"
}
```

- if retained current-value invalidation already makes K stale exactly as required, do not duplicate it.

Thus invalidation/freshness changes do not require a replacement ValueEvent.

## Migration writer state

Migration preserves continuing writer identity/sequence and retained foreign histories.

Representation rewriting must not reset or renumber journal positions or semantic authority coordinates.

The local NodeIdentifier allocation watermark may stay the same or advance according to the target migration. If its durable value changes, record the resulting local watermark with `WriterStateRecord`.

## Migration postcondition

Before cutover:

```text
target global/version == targetVersion
all retained journal records use targetVersion canonical format
old JournalRecordIds are preserved
project(Jafter, targetSchema) == Gtarget
```

The target journal/projection pair becomes active atomically.

Failure before cutover leaves the old source-version pair selected.

## Synchronization across migration

Ordinary synchronization requires compatible current database/schema interpretation and compatible current record format.

Replicas at different versions do not ordinary-sync until a supported migration path has brought them to a compatible target interpretation.

Shared pre-migration records independently rewritten through the same migration must compare identically after rewrite.

Canonical semantic migration records are then ordinary immutable history and synchronize exactly like any other records.

A delayed pre-migration host which did not participate in the canonical source-state reconciliation may still remain a valid old database, but it cannot independently manufacture an equivalent-looking target semantic baseline and expect occurrence identity to reconcile later. It must follow an explicit supported recovery/rebaseline/import path.

## Historical certificates after schema change

Old ValidateEvents remain intelligible historical evidence because their input NodeKeys are explicit.

Current replay uses an old certificate only when:

- it targets the selected current ValueId;
- its explicit input-key set equals the current target input set;
- ordinary invalidation/certificate-selection rules accept it.

Otherwise migration authors the target proof certificate required for the preserved/new ValueId.

## No historical migration execution during replay

Future replay does not call old migration callbacks.

The settled migration result is data in retained current-format records. Historical source records have already been deterministically rewritten into the target representation.

## Database-format evolution rule

When a future database version changes journal representation:

1. open the old replica under its declared source `global/version`;
2. rewrite every retained record into the target canonical representation while preserving identity/meaning;
3. compute the target graph;
4. preserve existing ValueIds for preserved occurrences;
5. append only the semantic value/delete/proof/freshness records needed for the target state;
6. obey the canonical-cohort rule when the migration creates/replaces value occurrences;
7. verify replay equivalence and journal invariants;
8. atomically cut over.

Do not add per-record version stamps, permanent decoder chains, mixed-format active journals, or synchronization-time conversion as an alternative.