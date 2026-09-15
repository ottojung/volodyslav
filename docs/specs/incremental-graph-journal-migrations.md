# IncrementalGraph Journal 3 Bootstrap and Migration

## Purpose

This document specifies:

1. initial bootstrap from a supported pre-Journal-3 IncrementalGraph database into replay-complete Journal 3 history; and
2. later database/schema migration when the input already contains Journal 3 history.

Both preserve:

```text
persistedGraph == project(retainedJournal)
```

Journal history is retained semantically across migration, but its persisted representation is not frozen forever. A database-version migration may rewrite every retained journal record into the target version's one canonical format while preserving record identity and historical meaning.

## Relationship to the existing migration framework

The existing migration framework decides the target IncrementalGraph state: values may be kept/replaced/created/deleted/invalidated and relowered under a new schema according to `migration.md`.

Journal 3 adds two distinct responsibilities to that version transition:

```text
source replica
    -> deterministically rewrite retained journal representation
       into the target database format
    -> controlled migration computes target graph
    -> append Journal 3 records settling target semantic facts
    -> verify target replay
    -> atomically cut over
```

The first step is representation migration. It changes how already-existing historical records are stored, not what historical facts their IDs denote.

The later migration baseline is semantic migration history. It records the actual new target graph state rather than pretending that the target state had always existed.

Future replay does not rerun the old application migration callback.

## One-format migration invariant

The active source replica is interpreted entirely according to its source `global/version`.

The inactive target replica is constructed entirely according to the target `global/version`.

No active or completed target replica may contain a mixture of source-format and target-format journal records. Journal records have no independent `recordVersion` field and ordinary replay has no per-record upcast/downcast path.

It is acceptable for old active and new inactive replicas to coexist temporarily during the migration transaction, because each replica individually has one coherent format and only one becomes active at cutover.

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

The target representation may add, remove, rename, normalize, or otherwise transform fields required by the target database version.

The rewrite is canonical and deterministic. Given the same source-version record and the same source->target migration definition, independently migrating replicas must produce the same target-format record. It must not depend on wall clock, randomness, external services, mutable graph cache bytes, or unrelated locally-retained concurrent history.

If semantic application/schema behavior changes, do not encode that change by silently changing the historical fact represented by an old `(author,sequence)`. Append new migration events as defined below.

## Whole-journal rewrite trade-off

A format-changing migration may have to inspect and rewrite every retained record before cutover.

Therefore migration time and I/O may be proportional to the number and serialized size of retained journal records. This is an accepted trade-off for the simpler invariant that a database contains only one current representation and never needs permanent historical record-version decoders.

The rewrite should remain streamable where practical; accepted whole-history time does not imply loading the complete journal into RAM.

## Common preconditions

Migration input must satisfy the source-version invariants it claims.

For a legacy graph being converted into Journal 3 this includes at least:

- expected shared materialized key sets for identifiers/values/freshness/timestamps;
- dependency closure under the source schema;
- structurally sound validity edges;
- complete incoming validity for fresh nodes;
- parseable timestamps with `createdAt <= modifiedAt`;
- valid local `last_node_index`.

For Journal-3-aware input, source journal streams must additionally be valid under the source database format before they are rewritten.

Malformed state is rejected rather than converted into journal history that merely makes corruption self-consistent.

# Part I: initial pre-Journal-3 bootstrap

## Goal

Given supported legacy graph Glegacy with no Journal 3 history, construct Jbootstrap directly in the target database's current Journal 3 format such that:

```text
project(Jbootstrap, legacy/current bootstrap schema) == Glegacy
```

without changing graph semantics merely to accommodate journaling.

There is no intermediate historical Journal-3 record format to preserve because the source has no Journal 3 history yet.

## Writer identity

Use the database's existing durable `DatabaseFingerprint` as JournalAuthor.

The initial writer stream starts at zero and bootstrap authors its first records.

A supported lifecycle must not independently bootstrap two continuing writable installations under one fingerprint. Discovery of divergent same-writer Journal 3 records is a fork.

Fingerprint collisions between independently-created databases are handled by the accepted collision-risk intent in `docs/intent-records/database-fingerprint.md`; Journal 3 does not introduce another writer identity solely for bootstrap.

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

Author in the target database's current record format:

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

After constructing the complete entry set, serialize it in the current canonical persisted NodeKeyString order defined by the types spec.

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

Replay must reconstruct exactly the same local allocator safety state. Because local NodeIdentifiers use the database fingerprint plus a strictly growing local index, preserving this watermark is what prevents future reuse within the continuing host namespace.

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

Bootstrap history and equivalent graph projection become durable atomically with the target `global/version` migration/cutover.

# Part II: Journal-3-aware migration

## Principle

A later migration starts from source-version history/state:

```text
Gbefore = project(Jbefore, sourceSchema)
```

First, rewrite the retained source journal into the target database representation:

```text
Jconverted = rewriteJournalFormat(Jbefore, sourceVersion, targetVersion)
```

where Jconverted has exactly the same retained record IDs and historical semantic facts as Jbefore, but every record is encoded canonically for the target version.

The controlled application migration computes:

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
Jafter = Jconverted + migration-authored records
```

The historical facts from Jbefore remain retained through Jconverted; only their database representation changed.

## Why use a full current-state migration baseline

Migration may change schema structure, dependency edges, materialization, payloads, timestamps, freshness, validity, and physical identifiers.

Trying to prove which old certificates/ValueIds remain reusable across arbitrary semantic migrations would make current replay depend on migration-specific historical reasoning.

Journal 3 uses a simpler rule:

> every target-present node receives a new migration ValueEvent plus a target-schema baseline certificate, even if migration physically reused equal payload bytes.

This makes the semantic schema/version cut explicit and ensures current proof never relies on an old structural interpretation.

The cost is O(current target materialization) new baseline records in addition to any O(retained journal size) representation rewrite. Both are acceptable for a controlled version transition.

## Migration observation cut

Migration runs under exclusive maintenance and observes one complete source frontier:

```text
Fmigrate = frontier(Jbefore) = frontier(Jconverted)
```

Every migration-authored semantic event is causally after Fmigrate plus earlier same-migration records it references.

The ordinary authority allocator begins after the greatest observed semantic authority. Representation rewriting must not itself create new authority coordinates or journal positions.

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

Serialize the completed basis in the target version's current canonical persisted NodeKeyString order. This reproduces target validity exactly while keeping the certificate independent of target-schema input enumeration order.

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

Representation rewriting must not reset or renumber:

- `DatabaseFingerprint`;
- any retained journal sequence;
- retained foreign writer streams;
- semantic authority coordinates.

The existing local NodeIdentifier allocator namespace continues across migration. Local `last_node_index` follows ordinary target migration allocation rules and may only stay the same or advance. If its durable value changes, the migration publication includes a WriterStateRecord for the resulting watermark.

This monotone allocator, together with the accepted DatabaseFingerprint collision assumption, is the uniqueness basis for future local NodeIdentifiers.

## Migration postcondition

Before cutover all of the following hold:

```text
target global/version == targetVersion
all retained journal records use targetVersion's canonical format
frontier(Jafter) extends frontier(Jbefore) without renumbering old IDs
project(Jafter, targetSchema) == Gtarget
```

The migration baseline and target graph become active atomically.

Failure before cutover leaves the old source-version Jbefore/Gbefore replica selected and unchanged.

## Synchronization across migration

Journal writer frontiers remain identity coordinates across migration because existing `(author,sequence)` IDs are preserved by format rewrite.

However, ordinary synchronization requires compatible **current** database/schema interpretation and therefore compatible current record format.

Replicas at different database versions do not semantically synchronize until supported migration brings them to the same compatible current version. Ordinary sync must not upcast/downcast source records on the fly.

Once both replicas have independently migrated, the same shared pre-migration records must have the same canonical target-format representation. Overlap comparison therefore remains exact rather than reporting a false fork.

Their migration baselines are ordinary causally later events and synchronization unions them normally.

Independent semantic migrations may produce concurrent target baselines. Ordinary authority/certificate replay resolves their union, possibly making derived caches stale when the independently migrated histories selected different input occurrences.

## Historical certificates after schema change

Representation migration preserves the historical semantic claim of each old ValidateEvent while re-encoding it into the target database format.

Because each certificate stores explicit semantic input NodeKeys, an old certificate remains intelligible historical evidence after schema migration.

Current replay does **not** apply it merely because it targets an old ValueId whose node name still exists. Current proof uses certificates for the selected current ValueId whose input-key set is compatible with current `inputEdges(K)`.

The semantic migration baseline ensures every target-present current node has a new target-schema ValueId/certificate.

A future feature that reconstructs an arbitrary historical pre-migration graph cut may still require the historical graph schema to know the complete structural graph at that cut. That diagnostic capability is separate from current-state recovery.

## No historical migration execution during replay

Future replay of Jafter does not call old migration callbacks and does not maintain old record-format interpreters.

The settled semantic migration output is data in current-format migration Value/Delete/Validate/Invalidate/WriterState records. Historical source records have already been rewritten into the same current representation.

Replay therefore applies one current record model only.

## Database-format evolution rule

When a future database version changes journal record representation:

1. open the old replica under its declared old `global/version` through the supported migration gate;
2. stream/rewrite every retained journal record into the target canonical representation while preserving ID and historical meaning;
3. construct any semantic migration baseline required by graph/schema changes;
4. verify target journal/projection invariants;
5. write only the target `global/version` for the target replica; and
6. atomically cut over.

Do not add per-record version stamps, permanent decoder/upcaster chains, mixed-format journals, or synchronization-time record conversion as an alternative to this whole-database migration model.