# IncrementalGraph Journal 3 Bootstrap and Migration

## Purpose

This document specifies:

1. initial bootstrap from a supported pre-Journal-3 IncrementalGraph database into a replay-complete Journal 3 database; and
2. later database/schema migration when the input already contains Journal 3 history.

Both operations preserve the Journal 3 law:

```text
persistedGraph == project(retainedJournal)
```

Migration never rewrites or deletes old authoritative journal records. It records the settled migration result as new replayable history.

## Relationship to the ordinary migration framework

The existing migration framework decides the target IncrementalGraph state: values may be kept, replaced, created, deleted, invalidated, and relowered under a new schema according to `migration.md`.

Journal 3 does not rerun that migration during replay.

Instead:

```text
old database
    -> ordinary controlled migration computes target graph
    -> Journal 3 records the settled target as immutable events
    -> future replay reconstructs that recorded target
```

Thus historical application callbacks, current wall time, external services, randomness, or old computors are never needed merely to replay an already completed migration.

## Common migration preconditions

The migration input must satisfy the invariants required by its source database version.

For a graph being converted into Journal 3, this includes at least:

- `identifiers_keys_map`, `values`, `freshness`, and `timestamps` have the expected materialized key set;
- current materialized nodes are dependency-closed under the source schema;
- every `valid` edge is structurally sound;
- fresh nodes have complete incoming validity;
- stored `createdAt <= modifiedAt` after canonical timestamp parsing;
- `last_node_index` is valid for the local fingerprint namespace.

Migration rejects malformed state rather than inventing replay history that merely makes corruption look consistent.

## Part I: initial pre-Journal-3 bootstrap

### Goal

Given a supported legacy graph `Glegacy` with no Journal 3 history, construct an initial journal `Jbootstrap` such that:

```text
project(Jbootstrap) == Glegacy
```

without changing the semantic contents of the existing graph sublevels merely to accommodate journaling.

### Writer identity

The initial Journal 3 writer is the database's existing durable `DatabaseFingerprint`.

Its stream initially has frontier zero:

```text
localWriter: 0
```

Bootstrap then authors the first immutable records under that writer.

A supported lifecycle must not independently bootstrap two continuing writable installations under the same fingerprint. Actual discovery of conflicting same-writer Journal 3 history is a fork and must be rejected.

### Why bootstrap uses a special value-authority allocation

Different pre-Journal-3 replicas may already contain analogous cached values with the same legacy `modifiedAt` but different host-local graph domains and enumeration history.

If bootstrap HLC logical coordinates depended on unrelated enumeration before a node, equal legacy occurrences could receive different artificial logical offsets. Later synchronization could then choose values from inconsistent writers solely because one host happened to enumerate more unrelated nodes first.

To preserve the intended `modifiedAt` conflict preference, initial bootstrap value occurrences use:

```text
authorityTime = {
    physical: canonical(modifiedAt),
    logical: 0
}
```

and bootstrap value records are allocated in nondecreasing `modifiedAt` order, with canonical `NodeKey` as the deterministic tie-breaker.

For equal authority times from different writers, ordinary writer fingerprint tie-breaking decides consistently. For equal authority times from the same writer, writer-local sequence is the final tie-breaker, so happened-before still extends the total semantic authority order.

This special allocator applies only to the initial pre-Journal-3 value baseline. Later semantic events use the ordinary HLC allocator.

### Bootstrap Pass 1: value occurrences

Enumerate every legacy materialized node K in:

```text
(canonical modifiedAt, canonical NodeKey)
```

order.

For each K author:

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

Pass 1 completes for **all** materialized nodes before any validation/invalidation event is authored, so every bootstrap validation can name the exact bootstrap occurrence of each direct input.

### Bootstrap Pass 2: validation basis

Process every materialized node in deterministic semantic topological order.

Let:

```text
inputEdges(K) = [D0, D1, ...]
```

Author one:

```text
ValidateEvent {
    node: K,
    value: bootstrapValueId(K),
    reason: "bootstrap",
    basis: [...]
}
```

with:

```text
basis[i] = bootstrapValueId(Di)
    if legacy valid[Di] contains K

basis[i] = "unknown"
    otherwise
```

This reproduces the exact legacy incoming validity relation.

For a fresh legacy node, existing graph invariants require every basis position to contain the current direct-input bootstrap ValueId.

For a stale node, complete, partial, or absent incoming proof is represented exactly without pretending to know historical occurrences which pre-Journal-3 storage never recorded.

### Bootstrap Pass 3: stale state

For every legacy node K whose freshness is `"potentially-outdated"`, author after its bootstrap validation:

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

This preserves stale freshness while keeping precisely the incoming validity edges represented by the bootstrap certificate.

No node-scoped bootstrap invalidation is required merely because pre-Journal-3 state does not reveal the historical cause of staleness. The exact current missing edges are already represented by `"unknown"`, and the value-scoped invalidation preserves the stale bit. Bootstrap records are published atomically, so another supported replica cannot observe the new bootstrap ValueId without also being able to receive its matching baseline history.

### Bootstrap Pass 4: writer allocation state

Record the legacy local allocation watermark with:

```text
WriterStateRecord {
    lastNodeIndex: legacy last_node_index
}
```

unless the implementation's same atomic bootstrap publication already contains an equivalent canonical writer-state record according to the Journal storage format.

Replay must reconstruct the same local allocator watermark.

### Absent legacy nodes

Pre-Journal-3 storage contains no authoritative history for arbitrary unmaterialized semantic keys.

Bootstrap therefore does not manufacture delete events for every theoretically absent graph node. The initial journal domain contains the historical facts actually represented by the legacy database.

### Bootstrap postcondition

Before cutover verify:

```text
project(Jbootstrap) == Glegacy
```

including:

- current semantic materialization set;
- selected `NodeIdentifier`s;
- exact payloads;
- timestamps;
- freshness;
- semantic validity edges;
- local `last_node_index`.

Bootstrap journal and unchanged/equivalent graph projection become durable atomically with the database-version migration/cutover.

## Part II: Journal-3-aware migration

### Principle

A later migration does not reinterpret the current materialized graph as independent authority.

Its source state is already:

```text
Gbefore = project(Jbefore)
```

The controlled migration computes a target graph:

```text
Gtarget
```

Journal 3 then appends a complete migration baseline sufficient to establish:

```text
project(Jafter) == Gtarget
```

where:

```text
Jafter = Jbefore + migration-authored records
```

Old Jbefore history remains retained.

### Why Journal 3 uses a full current-state migration baseline

Migration is intentionally allowed to change schema interpretation, dependency edges, materialization, values, timestamps, validity, and freshness.

Trying to prove which old certificates/value identities remain reusable across every possible migration would make replay dependent on migration-specific historical reasoning.

Journal 3 chooses a simpler rule:

> Every target-present node receives a new migration `ValueEvent` and baseline certificate, even when migration retained equal payload bytes.

This makes the migration cut explicit and causally dominates all history the migration observed.

It costs O(current target materialization) new records, which is acceptable for a rare version transition and avoids carrying migration-specific identity-preservation rules into future replay.

## Migration observation cut

Before authoring the migration baseline, the migration owns one stable source Journal 3 database under exclusive maintenance and observes its complete retained frontier:

```text
Fmigrate = frontier(Jbefore)
```

Every migration-authored semantic event context covers this frontier plus earlier same-migration records as applicable.

Its authority allocator begins after the greatest observed semantic authority in Jbefore.

Therefore the migration baseline is causally after all history the migrating database actually retained.

## Migration target domain

Let:

```text
BeforePresent = semantic NodeKeys present in Gbefore
TargetPresent = semantic NodeKeys present in Gtarget
MigrationDomain = BeforePresent union TargetPresent
```

A historical key which was already absent before migration and remains absent needs no new delete merely because old events still exist in the replay log.

A currently present old-schema key which is removed/renamed by migration belongs to `BeforePresent` and must receive explicit absence authority.

## Migration Pass 1: establish target heads

### Target-present K

For every K in `TargetPresent`, author:

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

The new migration event ID is K's new target `ValueId`.

This is true even when migration physically reused unchanged payload bytes from the old graph.

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

The migration target must not rely on the new schema merely ignoring an old selected value head. Structural/semantic removal is explicit journal history.

### Ordering

All target value/delete heads are allocated before target validation baselines.

Use deterministic ordering which extends dependencies and other required happened-before constraints. Canonical NodeKey ordering is the final tie-break where semantic ordering does not constrain two records.

## Migration Pass 2: target validity

After every target-present node has its new migration `ValueId`, author one `ValidateEvent(reason="migration")` for each target-present K.

For direct input Di:

```text
basis[i] = migrationValueId(Di)
    if Gtarget contains validity edge Di -> K

basis[i] = "unknown"
    otherwise
```

This exactly reproduces the target legacy validity relation under the target schema.

No pre-migration `ValidateEvent` is reused as the target certificate merely because its payload value happened to survive migration.

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

Because migration certificates are causally after the complete observed pre-migration frontier, prior node-scoped invalidations are covered by the new baseline. The target current proof state is represented explicitly by the migration certificate + optional target-value invalidation.

## Migration writer state

Migration preserves the continuing local writer identity and writer-stream sequence.

It must not reset:

- `DatabaseFingerprint`;
- local journal sequence;
- retained foreign writer streams; or
- derived observed authority high-water.

The local `last_node_index` follows the ordinary migration target's allocation rules. If its durable value changes, the migration publication includes a new `WriterStateRecord` for the resulting watermark.

## Migration postcondition

Before cutover:

```text
project(Jafter, targetSchema) == Gtarget
```

must hold.

The migration baseline and target graph become active atomically through the existing migration cutover.

Failure before cutover leaves Jbefore/Gbefore selected.

## Synchronization across migration

Journal 3 synchronization does not use per-source semantic cursors which need invalidation after migration. Retained immutable writer frontiers remain true statements about history.

However, ordinary synchronization requires compatible current database/schema interpretation.

Therefore two replicas at different database versions do not semantically synchronize until a supported migration brings them to a compatible version.

Once both replicas have migrated, their old histories remain retained and their migration baselines are ordinary causally-later events. Synchronization unions those histories normally.

Independent migrations may produce concurrent migration baselines. Journal 3 does not assume they are byte-identical. Ordinary causal conflict authority and validation replay resolve their union, possibly leaving some derived caches stale when the migrated histories depended on different input occurrences.

## No historical migration execution during replay

Future replay of Jafter must not call the old migration callback.

The migration callback's output has already been recorded in:

- migration `ValueEvent`s;
- migration `DeleteEvent`s;
- migration `ValidateEvent`s;
- migration `InvalidateEvent`s; and
- writer-state records when needed.

Replay applies those immutable facts using the generic Journal 3 rules.

## Journal record-format evolution

Because authoritative history is retained indefinitely, future software must continue to decode historical Journal 3 records which remain reachable in a supported database.

If a future database version changes the serialized journal record format or event meaning, that version must provide one of:

- backward decoding of the old immutable format;
- a pure deterministic upcast into the current in-memory record model; or
- another explicitly specified interpretation mechanism which preserves the old record's exact historical meaning.

A migration must not solve format evolution by destructively rewriting old record IDs or deleting old records.

Pure decoding/upcasting is not the same as rerunning an application migration or computor: it may only reinterpret the immutable bytes of one historical record according to its recorded format/version contract.

Before the first incompatible persisted Journal 3 record format is introduced, the serialized record representation must include sufficient version discrimination to select the correct decoder unambiguously.

## Schema history

Current graph projection is evaluated under the running/current schema after the migration baseline.

Old records remain inspectable history. A target schema is not permitted to leave a selected current `ValueEvent` for a semantic node which that target schema cannot represent. Migration must delete/remap/rebaseline such current nodes explicitly.

A future diagnostic feature which wants to reconstruct an arbitrary **historical** pre-migration graph cut may additionally need the historical schema for that cut. Durable historical-schema archival is a diagnostics feature distinct from the core guarantee that the current graph can be reconstructed from the retained journal plus the current compatible schema interpretation.
