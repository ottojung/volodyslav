# IncrementalGraph Journal 3 Bootstrap and Migration

## Purpose

This document specifies:

1. initial bootstrap from a supported pre-Journal-3 IncrementalGraph database into replay-complete Journal 3 history; and
2. later database/schema migration when the input already contains Journal 3 history.

Both preserve:

```text
persistedGraph == project(retainedJournal)
```

Migration never deletes or rewrites old authoritative journal records. It records the settled target as new replayable history.

## Relationship to the existing migration framework

The existing migration framework decides the target IncrementalGraph state: values may be kept/replaced/created/deleted/invalidated and relowered under a new schema according to `migration.md`.

Journal 3 does not rerun that migration during replay.

Instead:

```text
old database
    -> controlled migration computes target graph
    -> Journal 3 records settled target facts
    -> future replay reconstructs those facts
```

Historical callbacks, wall clock, external services, randomness, and computors are therefore unnecessary merely to reconstruct a migration which already completed.

## Common preconditions

Migration input must satisfy the source-version invariants it claims.

For a legacy graph being converted into Journal 3 this includes at least:

- expected shared materialized key sets for identifiers/values/freshness/timestamps;
- dependency closure under the source schema;
- structurally sound validity edges;
- complete incoming validity for fresh nodes;
- parseable timestamps with `createdAt <= modifiedAt`;
- valid local `last_node_index`.

Malformed state is rejected rather than converted into journal history that merely makes corruption self-consistent.

# Part I: initial pre-Journal-3 bootstrap

## Goal

Given supported legacy graph Glegacy with no Journal 3 history, construct Jbootstrap such that:

```text
project(Jbootstrap, legacy/current bootstrap schema) == Glegacy
```

without changing graph semantics merely to accommodate journaling.

## Writer identity

Use the database's existing durable `DatabaseFingerprint` as JournalAuthor.

The initial writer stream starts at zero and bootstrap authors its first records.

A supported lifecycle must not independently bootstrap two continuing writable installations under one fingerprint. Discovery of divergent same-writer Journal 3 records is a fork.

## Bootstrap authority for value occurrences

Pre-Journal-3 replicas may contain analogous current values with the same legacy `modifiedAt` but different unrelated materialized-node counts/enumeration history.

If equal-time bootstrap values consumed ordinary global HLC logical increments, cross-host value precedence could depend on how many unrelated nodes one host enumerated first.

Therefore initial bootstrap ValueEvents use the special rule from the types spec:

```text
authorityTime = {
    physical: canonical(modifiedAt),
    logical: 0
}
```

and are allocated in nondecreasing `(modifiedAt, canonical NodeKey)` order.

Equal-time values from different writers then tie-break by writer fingerprint rather than unrelated enumeration depth. Equal-time values within one writer still have total same-writer order through sequence.

After all bootstrap ValueEvents, bootstrap returns to ordinary HLC allocation for validation/invalidation events with high-water raised to at least the greatest bootstrap value authority.

## Bootstrap Pass 1: value occurrences

Enumerate every legacy materialized node K in deterministic:

```text
(canonical modifiedAt, canonical NodeKey)
```

order.

Author:

```text
ValueEvent {
    recordVersion: 1,
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

Pass 1 completes for **all** materialized nodes before bootstrap validation events, so every known basis occurrence is causally earlier in the same writer stream.

## Bootstrap Pass 2: self-describing validation baseline

Process materialized nodes in deterministic semantic/topological order under the legacy bootstrap schema.

For K let the legacy bootstrap schema define the distinct direct input set:

```text
inputSet(K) = set(inputEdges(K))
```

author:

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

with exactly one entry for every `D in inputSet(K)`.

For each D:

```text
basisEntry(D).value = bootstrapValueId(D)
    if legacy valid[D] contains K

basisEntry(D).value = "unknown"
    otherwise
```

After constructing the complete entry set, serialize it in canonical semantic NodeKey order. The persisted historical certificate therefore does not depend on the source schema's positional input ordering.

For a fresh legacy node, existing invariants require every entry to contain the current bootstrap ValueId.

For a stale node, complete/partial/absent incoming proof is represented exactly without inventing historical occurrences which pre-Journal-3 storage never recorded.

## Bootstrap Pass 3: stale state

For every legacy stale K, author after its bootstrap certificate:

```text
InvalidateEvent {
    node: K,
    scope: {
        kind: "value",
        value: bootstrapValueId(K)
    },
    reason: "bootstrap"
}
```

This reproduces stale freshness while preserving exactly the incoming validity edges represented by known/unknown basis entries.

No node-scoped bootstrap invalidation is required merely because legacy state cannot reveal the original cause of stale status.

## Bootstrap Pass 4: writer allocation state

Record the legacy local allocation watermark:

```text
WriterStateRecord {
    lastNodeIndex: legacy last_node_index
}
```

unless an equivalent writer-state record is already canonically represented by the same atomic bootstrap publication format.

Replay must reconstruct exactly the same local allocator safety state.

## Absent legacy nodes

Legacy storage has no authoritative history for arbitrary unmaterialized semantic keys.

Bootstrap does not manufacture DeleteEvents for every theoretically absent node in the infinite graph. Its initial semantic domain is the finite state actually represented by the legacy database.

## Bootstrap postcondition

Before cutover:

```text
project(Jbootstrap) == Glegacy
```

including:

- materialization set;
- selected NodeIdentifiers;
- exact payloads;
- timestamps;
- freshness;
- semantic validity edges;
- local `last_node_index`.

Bootstrap history and equivalent graph projection become durable atomically with the database-version migration/cutover.

# Part II: Journal-3-aware migration

## Principle

A later migration starts from:

```text
Gbefore = project(Jbefore, sourceSchema)
```

The controlled migration computes:

```text
Gtarget
```

under the target schema/version.

Journal 3 then appends a complete migration baseline establishing:

```text
project(Jafter, targetSchema) == Gtarget
```

where:

```text
Jafter = Jbefore + migration-authored records
```

Jbefore remains retained.

## Why use a full current-state migration baseline

Migration may change schema structure, dependency edges, materialization, payloads, timestamps, freshness, validity, and physical identifiers.

Trying to prove which old certificates/ValueIds remain reusable across arbitrary migrations would make current replay depend on migration-specific historical reasoning.

Journal 3 uses a simpler rule:

> every target-present node receives a new migration ValueEvent plus a target-schema baseline certificate, even if migration physically reused equal payload bytes.

This makes the schema/version cut explicit and ensures current proof never relies on an old positional/structural interpretation.

The cost is O(current target materialization) baseline records, acceptable for a controlled version transition.

## Migration observation cut

Migration runs under exclusive maintenance and observes one complete source frontier:

```text
Fmigrate = frontier(Jbefore)
```

Every migration-authored semantic event is causally after Fmigrate plus earlier same-migration records it references.

The ordinary authority allocator begins after the greatest observed semantic authority.

## Migration target domain

Let:

```text
BeforePresent = semantic NodeKeys present in Gbefore
TargetPresent = semantic NodeKeys present in Gtarget
MigrationDomain = BeforePresent union TargetPresent
```

A key already absent before and still absent needs no new delete merely because old historical records exist.

A current source-schema key removed/renamed by migration belongs to BeforePresent and receives explicit target absence authority.

## Migration Pass 1: target heads

### Target-present K

For every K in TargetPresent author:

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

The new record ID is K's target migration ValueId, even if payload bytes were unchanged physically.

### Removed K

For every:

```text
K in BeforePresent - TargetPresent
```

author:

```text
DeleteEvent {
    node: K,
    reason: "migration"
}
```

The target must not merely rely on the new schema ignoring an old selected current ValueEvent. Removal is explicit history.

### Ordering

All target value/delete heads are allocated before validation baselines which reference migration ValueIds.

Use deterministic ordering extending reference/dependency constraints, with canonical NodeKey as final tie-break where semantics do not impose order.

## Migration Pass 2: self-describing target validity

After every target-present node has its migration ValueId, for each target-present K let the target schema define:

```text
inputSet(K) = set(inputEdges(K))
```

author:

```text
ValidateEvent {
    node: K,
    value: migrationValueId(K),
    reason: "migration",
    basis: [
        {
            input: D,
            value: migrationValueId(D) | "unknown"
        },
        ...
    ]
}
```

with exactly one entry for every `D in inputSet(K)`.

For each target direct input D:

```text
basisEntry(D).value = migrationValueId(D)
    if Gtarget contains validity edge D -> K

basisEntry(D).value = "unknown"
    otherwise
```

Serialize the completed basis in canonical semantic NodeKey order. This reproduces target validity exactly while keeping the immutable certificate independent of target-schema input enumeration order.

No pre-migration ValidateEvent is reused as the target current certificate merely because a payload survived migration.

## Migration Pass 3: target stale state

For every target-present K whose Gtarget freshness is `"potentially-outdated"`, author after its migration validation:

```text
InvalidateEvent {
    node: K,
    scope: {
        kind: "value",
        value: migrationValueId(K)
    },
    reason: "migration"
}
```

Fresh target nodes receive no migration invalidation.

Migration certificates are causally after the full observed pre-migration frontier, so they cover prior node-scoped invalidations. The target's current proof state is represented explicitly by the new certificate plus optional current-value stale marker.

## Migration writer state

Migration preserves continuing writer identity/sequence and retained foreign histories.

It must not reset:

- `DatabaseFingerprint`;
- local journal sequence;
- retained foreign writer streams;
- derived observed authority high-water.

Local `last_node_index` follows ordinary target migration allocation rules. If its durable value changes, the migration publication includes a WriterStateRecord for the resulting watermark.

## Migration postcondition

Before cutover:

```text
project(Jafter, targetSchema) == Gtarget
```

The migration baseline and target graph become active atomically.

Failure before cutover leaves Jbefore/Gbefore selected.

## Synchronization across migration

Journal 3 immutable writer frontiers remain valid history coordinates across migration; there is no per-source semantic cursor to invalidate.

However, ordinary synchronization requires compatible **current** database/schema interpretation.

Replicas at different versions do not semantically synchronize until supported migration brings them to a compatible current version.

Once both have migrated, their old histories remain retained and their migration baselines are ordinary causally later events. Synchronization unions them normally.

Independent migrations may produce concurrent target baselines. Ordinary authority/certificate replay resolves their union, possibly making derived caches stale when the independently migrated histories selected different input occurrences.

## Historical certificates after schema change

Because each ValidateEvent stores explicit semantic input NodeKeys, old certificates remain understandable historical facts after schema migration.

Current replay does **not** apply an old certificate merely because it targets an old ValueId whose node name still exists. Current proof uses certificates for the selected current ValueId whose input-key set is compatible with current `inputEdges(K)`.

The migration baseline ensures every target-present current node has a new target-schema ValueId/certificate.

Therefore current-state replay does not need historical schema ordering merely to decode old certificate claims.

A future feature that reconstructs an arbitrary historical pre-migration graph cut may still require the historical graph schema to know the complete structural graph at that cut. That diagnostic capability is separate from current-state recovery.

## No historical migration execution during replay

Future replay of Jafter does not call old migration callbacks.

Their settled output is data in migration Value/Delete/Validate/Invalidate/WriterState records.

Replay applies those facts through generic Journal 3 rules.

## Journal record-format evolution

Authoritative history is retained indefinitely, so future software must continue to decode retained historical record versions.

Every record carries `recordVersion`.

A future implementation may provide:

- backward decoding of the historical immutable format;
- pure deterministic upcasting to the current in-memory record model; or
- another explicit version interpreter preserving historical meaning.

It must not solve format evolution by changing an old record's `(author,sequence)` meaning or destructively replacing/deleting history.

A decoder/upcaster may inspect only the persisted record representation/version semantics required to interpret that record; it must not rerun application migration code, call computors, read wall time, or perform external I/O.
