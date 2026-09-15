# IncrementalGraph Journal 3 Bootstrap and Migration

## Purpose

This document specifies:

1. initial bootstrap from a supported pre-Journal-3 IncrementalGraph database into replay-complete Journal history; and
2. later database/schema migration when the input already contains Journal history.

Both preserve:

```text
persistedGraph == project(retainedJournal)
```

The central identity rule is:

> Migration must not manufacture a new ValueId merely because the database version, schema, proof state, freshness, or stored representation changed. A new ValueEvent is required only when the semantic value occurrence itself is created or replaced.

That rule includes `MigrationStorage.override()`: override is a semantic-preserving representation rewrite and therefore preserves the selected ValueId.

## Relationship to the existing migration framework

The existing migration framework decides the target IncrementalGraph state using `keep`, `override`, `invalidate`, `delete`, and `create` as specified by `migration.md`.

Journal 3 adds three responsibilities:

```text
source replica
    -> deterministically rewrite retained Journal representation
       into the target database format
    -> controlled migration computes target graph
    -> append only semantic records required for actual semantic/proof/freshness changes
    -> verify target replay
    -> atomically cut over
```

Representation migration changes how an already-existing historical fact is encoded, not which historical fact its `JournalRecordId` denotes.

Future replay never reruns the historical migration callback.

## One-format migration invariant

The active source replica is interpreted entirely according to its source `global/version`.

The inactive target replica is constructed entirely according to the target `global/version`.

No active or completed target replica may contain a mixture of source-format and target-format Journal records. Journal records have no independent `recordVersion` field and ordinary replay has no per-record upcast/downcast path.

## Representation rewrite contract

For every existing source Journal record:

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
- every `ValueId`/record reference continues to name the same Journal identity;
- writer-stream sequence/contiguity is unchanged.

The rewrite is canonical and deterministic. Given the same source-version record and source->target migration definition, independently migrating replicas produce the same target-format record.

The canonical target representation may differ byte-for-byte from the source representation. That is particularly important for semantic-preserving `override()` migrations.

If the representation of `ComputedValue` changes between versions, the migration must define a deterministic target-format rewrite for every retained `ValueEvent` whose payload uses the changed representation. For the currently selected occurrence of a node decided with `override()`, the rewritten selected `ValueEvent` keeps its existing `JournalRecordId`, `NodeIdentifier`, `createdAt`, `modifiedAt`, causal identity, and semantic value while its target-version payload representation becomes the override result.

`override()` MUST NOT be used for a semantic value change. A migration that changes the meaning/value of a node follows the ordinary migration contract (`invalidate()`/recomputation or another explicit semantic replacement) and does not disguise that change as record-format rewriting.

If application/schema semantics change independently of representation, that semantic change is represented by newly appended migration events. It must not be smuggled into the rewritten historical meaning of an old record.

## Whole-journal rewrite trade-off

A format-changing migration may inspect/rewrite every retained record before cutover. Time and I/O proportional to retained Journal size are accepted. The rewrite should still be streamable where practical.

## Common preconditions

Migration input must satisfy the source-version invariants it claims.

For a legacy graph being converted into Journal 3 this includes at least:

- expected shared materialized key sets for identifiers/values/freshness/timestamps;
- dependency closure under the source schema;
- structurally sound validity edges;
- complete incoming validity for fresh nodes;
- parseable timestamps with `createdAt <= modifiedAt`;
- valid local `last_node_index`.

For Journal-aware input, source Journal streams must additionally be valid under the source database format, including transitively closed event contexts.

Malformed state is rejected rather than converted into history which merely makes corruption self-consistent.

# Part I: initial pre-Journal bootstrap

## Goal

Given one supported legacy graph `Glegacy` with no Journal history, establish Journal state such that:

```text
project(Jafter, localWriter) == Glegacy
```

while keeping shared legacy occurrences on shared ValueIds whenever a canonical bootstrap already exists.

## Why bootstrap uses one canonical semantic basis

Two legacy replicas may represent the same shared cached occurrence but have no ValueId because ValueIds did not exist before Journal 3.

If each host independently minted ValueIds for all equivalent legacy nodes, later synchronization could select an input occurrence from one bootstrap and a dependent occurrence from another. The dependent certificate would then point at a losing ValueId even though the legacy state had been mutually valid before upgrade.

Therefore a synchronization cohort uses one canonical semantic bootstrap history as the shared identity basis. A late or divergent legacy host does **not** have to discard local state to join that basis: it retains the canonical records and appends a local bootstrap delta for the differences it actually has.

This is a lifecycle rule, not a transport protocol.

## Canonical bootstrap source decision

The lifecycle has one configured transport-neutral **cohort bootstrap source**, analogous to the installation recovery source.

Before a pre-Journal installation chooses whether to create or join the canonical semantic bootstrap, it queries that source. Exactly three outcomes are supported:

1. **canonical bootstrap source exists** — hold its stable snapshot and `joinCanonicalBootstrap`;
2. **source definitively does not exist** — this installation may `createCanonicalBootstrap`;
3. **query/read failed or result is indeterminate** — migration/startup fails and MUST NOT create a competing canonical history.

A source may report definitive absence only when its lifecycle semantics make that answer suitable for first-creator selection. If concurrent would-be creators cannot be safely distinguished, the result is indeterminate rather than permission for both to create.

If two distinct canonical bootstrap histories are nevertheless discovered for one cohort, that is an unsupported bootstrap fork requiring explicit operator recovery; Journal synchronization does not merge them by payload equality.

The only remote dependency is availability of one canonical bootstrap snapshot; no other host needs to reconcile, acknowledge, or return, per `$id-4719065396881648`.

## Canonical bootstrap writer

The installation which receives the definite-absence/create outcome uses its existing durable `DatabaseFingerprint` as the author of the canonical semantic bootstrap.

Its Journal stream starts at zero and authors the semantic baseline below.

Other installations retain those exact canonical semantic records and then author only their own local bootstrap delta and local writer-state record as needed.

## Bootstrap authority for canonical value occurrences

Canonical bootstrap `ValueEvent`s use:

```text
authorityTime = {
    physical: canonical(modifiedAt),
    logical: 0
}
```

and are allocated in nondecreasing `(modifiedAt, canonical NodeKey)` order.

After canonical bootstrap ValueEvents, ordinary HLC allocation resumes for validation/invalidation records with high-water raised to at least the greatest bootstrap value authority.

## Canonical bootstrap Pass 1: value occurrences

For every materialized node K in the canonical legacy state, author:

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

and call its ID `bootstrapValueId(K)`.

All canonical bootstrap ValueEvents are created before canonical validation events.

## Canonical bootstrap Pass 2: validation baseline

For every materialized K, author:

```text
ValidateEvent {
    node: K,
    value: bootstrapValueId(K),
    reason: "bootstrap",
    basis: [
        { input: D, value: bootstrapValueId(D) | "unknown" },
        ...
    ]
}
```

with exactly one entry per direct input D in canonical persisted NodeKey order.

Use `bootstrapValueId(D)` when the canonical legacy `valid[D]` contains K, otherwise `"unknown"`.

## Canonical bootstrap Pass 3: stale state

For every canonical legacy stale K, author:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "value", value: bootstrapValueId(K) },
    reason: "bootstrap"
}
```

after its bootstrap certificate.

## Canonical bootstrap Pass 4: creator writer state

The canonical creator records its own legacy allocation watermark with a `WriterStateRecord`.

## Joining the canonical bootstrap with a local delta

A joining installation keeps its **own** existing `DatabaseFingerprint`; it never clones the canonical creator's local writer identity.

Let:

```text
Jc = retained canonical bootstrap history
Pc = project(Jc, localWriter=joiningFingerprint)
Glegacy = joining installation's supported local legacy graph
```

The join proceeds as follows:

1. retain all canonical bootstrap records verbatim;
2. set `localWriter` to the joining installation's existing fingerprint;
3. compare `Pc` with `Glegacy` node-by-node;
4. apply the reset specification's minimal Pass 1–3 rules with target `Glegacy` instead of a source snapshot, authoring required semantic records under the joining writer with reason `"bootstrap"`;
5. record the joining writer's own `last_node_index` with `WriterStateRecord` when not already represented;
6. verify `project(Jjoined, joiningFingerprint) == Glegacy` and atomically cut over.

For a node whose canonical selected occurrence has the same immutable semantic occurrence fields required by `Glegacy`, the canonical ValueId is preserved.

For a node whose local legacy occurrence actually differs, the joining writer authors the minimal replacement `ValueEvent(reason="bootstrap")`. Local-only absence/presence differences are represented by the corresponding minimal Delete/Value transition. Validity/freshness differences are represented with bootstrap Validate/Invalidate records rather than replacing an otherwise-equal occurrence.

Thus an offline host's legitimate legacy delta survives upgrade without destroying shared ValueIds for every unaffected node.

The join does not compare payloads to infer historical identity during ordinary synchronization; this equality comparison is a controlled one-time migration decision between the held canonical bootstrap projection and the local legacy target.

## Bootstrap postcondition

For the canonical creator:

```text
semanticGraph(project(Jbootstrap)) == semanticGraph(Gcanonical)
```

For a joining installation with local delta:

```text
semanticGraph(project(Jjoined, joiningFingerprint)) == semanticGraph(Glegacy)
```

and every unaffected canonical occurrence retains the canonical ValueId.

# Part II: Journal-aware migration

## Principle

A later migration starts from:

```text
Gbefore = project(Jbefore, sourceSchema)
```

rewrites retained history into target representation:

```text
Jconverted = rewriteJournalFormat(Jbefore, sourceVersion, targetVersion)
```

and computes target graph `Gtarget` under the target schema/version.

The semantic phase appends only the records required so that:

```text
project(Jafter, targetSchema) == Gtarget
```

where:

```text
Jafter = Jconverted + migration-authored records
```

Journal-aware migration does **not** require a canonical cohort source. Each replica may migrate independently from its own supported source history.

## Migration decision semantics and ValueId identity

The existing migration decision is authoritative about whether the semantic occurrence survives:

### `keep`

`keep` preserves the current semantic occurrence and its target-format representation. The selected ValueId remains unchanged.

### `override`

`override` is semantic-preserving by contract. It preserves the selected ValueId even if the target-version stored payload representation differs.

The representation difference is realized by the deterministic whole-history rewrite described above, not by a new `ValueEvent`.

The target selected occurrence therefore has:

```text
same ValueId
same semantic value
same NodeIdentifier
same createdAt
same modifiedAt
possibly different target-version payload bytes/structure
```

A migration implementation must verify that the target selected record produced by the representation rewrite agrees with the migration's `override()` result.

### `invalidate`

`invalidate` preserves the cached semantic occurrence and ValueId, marks it stale, and may require migration invalidation/proof records. It does not itself create a new ValueEvent.

### `delete`

`delete` establishes absence with `DeleteEvent(reason="migration")` when the converted history still selects a value.

### `create`

`create` establishes a genuinely new occurrence and therefore authors a new `ValueEvent(reason="migration")` with a new ValueId.

Any other migration operation which explicitly creates/replaces the semantic value occurrence likewise creates a new ValueEvent. Merely changing schema, proof, freshness, database version, or serialized representation does not.

## Independent migration of genuine replacement occurrences

Two replicas may independently run the same Journal-aware migration. If the migration genuinely creates/replaces an occurrence, each replica may author its own new ValueEvent for that occurrence.

After later synchronization one occurrence wins by normal Journal conflict authority. A dependent whose certificate names the losing replacement ValueId may become stale and recompute/revalidate. This is an accepted trade-off rather than a reason to require one remote canonical migration participant.

Occurrence-preserving migrations—including `keep`, `override`, proof-only changes, freshness-only changes, and representation-only whole-history rewrites—retain the already-shared ValueIds and therefore do not create this artificial split.

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

- if the migration decision preserves K's semantic occurrence (`keep`, `override`, `invalidate`, or equivalent), set `targetValueId(K) = valueId_Gbefore(K)` and author no ValueEvent;
- if the migration genuinely creates/replaces K's semantic occurrence, author one `ValueEvent(reason="migration")` and use its ID as `targetValueId(K)`.

For every K in `BeforePresent - TargetPresent`, author exactly one required `DeleteEvent(reason="migration")` unless the converted history already selects absence after the migration observation cut.

## Migration Pass 2: target proof

After every `targetValueId(K)` is known, migration MAY reuse an existing eligible current-shape certificate only when replay under the target schema already yields exactly `Gtarget`'s validity for K and the certificate covers the migration-observed invalidations required for the target state.

Otherwise author one migration `ValidateEvent` targeting the preserved-or-new `targetValueId(K)`:

```text
ValidateEvent {
    node: K,
    value: targetValueId(K),
    reason: "migration",
    basis: [
        { input: D, value: targetValueId(D) | "unknown" },
        ...
    ]
}
```

with one entry for every target direct input D in canonical NodeKey order.

Use `targetValueId(D)` exactly when `Gtarget` contains validity edge `D -> K`; otherwise use `"unknown"`.

## Migration Pass 3: target freshness

After target proof selection:

- if `Gtarget` says K is fresh and replay already yields fresh, author no invalidation;
- if `Gtarget` says K is stale and replay would otherwise be fresh, author a value-scoped `InvalidateEvent(reason="migration")` targeting `targetValueId(K)`;
- if retained current-value invalidation already makes K stale exactly as required, do not duplicate it.

Thus proof/freshness changes do not require a replacement ValueEvent.

## Migration writer state

Migration preserves continuing writer identity/sequence and retained foreign histories.

Representation rewriting must not reset or renumber Journal positions or semantic authority coordinates.

The local NodeIdentifier allocation watermark may stay the same or advance according to the target migration. If its durable value changes, record the resulting local watermark with `WriterStateRecord`.

## Migration postcondition

Before cutover:

```text
target global/version == targetVersion
all retained Journal records use targetVersion canonical format
old JournalRecordIds are preserved
project(Jafter, targetSchema) == Gtarget
```

The target Journal/projection pair becomes active atomically.

Failure before cutover leaves the old source-version pair selected.

## Synchronization across migration

Ordinary synchronization requires compatible current database/schema interpretation and compatible current record format.

Replicas at different versions do not ordinary-sync until each has independently reached a compatible target interpretation through a supported migration path.

Shared pre-migration records independently rewritten through the same format migration compare identically after rewrite.

Migration-authored new semantic records then synchronize like any other immutable history. If independently migrating replicas created distinct replacement occurrences, ordinary head/certificate/freshness rules handle the resulting conflict and possible downstream staleness.

No particular peer must have participated in migration or return later.

## Historical certificates after schema change

Old ValidateEvents remain intelligible historical evidence because their input NodeKeys are explicit.

Current replay uses an old certificate only when:

- it targets the selected current ValueId;
- its explicit input-key set equals the current target input set;
- ordinary invalidation/certificate-selection rules accept it.

Otherwise migration authors the target proof certificate required for the preserved/new ValueId.

## No historical migration execution during replay

Future replay does not call migration code. All current semantic consequences are represented in retained target-format history.

## Atomic publication

Migration is a maintenance transition:

1. source remains active;
2. inactive target is built;
3. retained history is completely rewritten into target format;
4. target semantic records are appended;
5. replay/projection and graph invariants are verified;
6. one atomic cutover selects target.

Failure before cutover leaves the previous active pair selected.

## Required tests

At minimum cover:

- canonical bootstrap creation when the cohort bootstrap source is definitively absent;
- canonical bootstrap join when the source exists;
- indeterminate cohort bootstrap query fails without creating history;
- two competing canonical histories are detected as unsupported rather than payload-merged;
- joining host with one local legacy change retains canonical ValueIds for every unaffected node and authors a local bootstrap ValueEvent only for the changed occurrence;
- canonical bootstrap preserves payloads/timestamps/identifiers/freshness/validity exactly for the creator;
- stale partial validity uses controlled `"unknown"`;
- `keep` preserves ValueId;
- `override()` changes target representation while preserving ValueId and semantic meaning;
- two replicas independently performing the same representation-only `override()` retain the same shared ValueId after migration and synchronization;
- `invalidate()` preserves ValueId while making the occurrence stale as required;
- proof-only/freshness-only/schema-only changes preserve ValueId;
- `create()` or a true semantic replacement creates a new ValueId;
- independently migrated true replacement occurrences may differ in ValueId and may stale dependents after synchronization;
- whole-history representation rewrite preserves every old ID/reference/causal meaning;
- target contains one current record format only;
- replay target equals migration target;
- migration failure before cutover leaves source selected;
- no historical migration callback is required for future replay.

## Non-goals

This specification does not define Git branch mechanics, a hosted synchronization backend, SQL/HTTP APIs, deployment orchestration, or another transport protocol.