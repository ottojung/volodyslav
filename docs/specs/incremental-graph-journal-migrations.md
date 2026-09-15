# IncrementalGraph Journal 3 Bootstrap and Migration

## Purpose

This document specifies:

1. initial bootstrap from a supported pre-Journal IncrementalGraph database into replay-complete Journal history; and
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

Journal adds three responsibilities:

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

### Pure per-record payload rewrite

When `ComputedValue` representation changes between database versions, the migration definition supplies one deterministic payload codec for retained `ValueEvent`s:

```text
rewriteValuePayload(sourceVersion, targetVersion, sourceValueEvent)
    -> targetVersionPayload
```

The result is a pure function of the source record and the version-migration definition. It is applied to **every** retained ValueEvent whose payload representation changes, regardless of:

- whether that occurrence is currently selected;
- which replica is performing migration;
- what other records the replica happens to retain;
- migration callback traversal/order; or
- mutable replica-local state.

The rewritten record keeps its existing `JournalRecordId`, `NodeIdentifier`, `createdAt`, `modifiedAt`, causal identity, authority meaning, references, and semantic value.

`MigrationStorage.override()` does not supply authoritative replacement bytes for an existing Journal record. For Journal-aware migration it is an occurrence-preserving decision/assertion: the callback result for the selected occurrence MUST equal the payload produced for that selected record by the canonical per-record codec. A mismatch fails migration before cutover.

This restriction is necessary because the same historical `JournalRecordId` may be retained on replicas where that occurrence is selected on one replica and historical on another. The target body for one immutable ID cannot depend on selection or other replica-local state.

`override()` MUST NOT be used for a semantic value change. A migration that changes the meaning/value of a node follows the ordinary migration contract (`invalidate()`/recomputation or another explicit semantic replacement) and does not disguise that change as record-format rewriting.

If application/schema semantics change independently of representation, that semantic change is represented by newly appended migration events. It must not be smuggled into the rewritten historical meaning of an old record.

## Whole-journal rewrite trade-off

A format-changing migration may inspect/rewrite every retained record before cutover. Time and I/O proportional to retained Journal size are accepted. The rewrite should still be streamable where practical.

## Common preconditions

Migration input must satisfy the source-version invariants it claims.

For a legacy graph being converted into Journal history this includes at least:

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

A pre-Journal installation enters one shared Journal identity basis without turning the **time at which it upgrades** into semantic precedence over legacy values.

A late installation may carry legacy state which differs from the canonical bootstrap state. Such differences are converted as historical legacy evidence and merged with the canonical basis under the normal concurrent-value authority policy; they are not reset-style writes causally after the canonical state.

## Why bootstrap uses one canonical semantic basis

Two legacy replicas may represent the same shared cached occurrence but have no ValueId because ValueIds did not exist before Journal history.

If each host independently minted ValueIds for all equivalent legacy nodes, later synchronization could select an input occurrence from one bootstrap and a dependent occurrence from another. The dependent certificate would then point at a losing ValueId even though the legacy state had been mutually valid before upgrade.

Therefore a synchronization cohort uses one canonical semantic bootstrap history as the shared identity basis.

This is a lifecycle rule, not a transport protocol.

## Canonical bootstrap artifact

The canonical bootstrap is an immutable lifecycle artifact representing **exactly the original bootstrap cut**, not an arbitrary later Journal snapshot.

Conceptually:

```text
CanonicalBootstrapSnapshot {
    databaseVersion: Version
    graphSchemeString: string
    creatorWriter: JournalAuthor
    bootstrapFrontier: JournalFrontier

    get(author, sequence) -> JournalRecord | undefined
    iterate(author, afterExclusive, throughInclusive)
        -> AsyncIterable<JournalRecord>
}
```

Normative properties:

1. `bootstrapFrontier` is the creator's retained frontier immediately after the canonical bootstrap publication and before any ordinary post-bootstrap Journal operation;
2. the snapshot exposes exactly the immutable records through that frontier and no later records;
3. the cut is causally closed and replayable under `databaseVersion` / `graphSchemeString`;
4. those compatibility fields are the **bootstrap target** database version/schema, not the creator's later current version/schema;
5. the artifact remains immutable and retrievable for late legacy installations even after ordinary cohort history grows or active replicas migrate to later database versions;
6. an ordinary current `JournalSnapshot` is not a substitute merely because it contains the bootstrap records as a prefix.

This artifact is lifecycle source state, not an additional record format inside an active JournalReplica. The one-current-format invariant still applies to every active database replica.

`createCanonicalBootstrap` succeeds only after this exact cut is durably established for the cohort bootstrap source. Ordinary Journal writes must not begin on the creator while the canonical cut is still ambiguous or unavailable.

## Canonical bootstrap source decision

The lifecycle has one configured transport-neutral **cohort bootstrap source**, analogous to the installation recovery source.

Conceptually it returns:

```text
Exists(CanonicalBootstrapSnapshot)
DefinitelyAbsent
IndeterminateOrError
```

Exactly three outcomes are supported:

1. **canonical bootstrap artifact exists** — hold that immutable artifact and `joinCanonicalBootstrap`;
2. **source definitively does not exist** — this installation may `createCanonicalBootstrap`;
3. **query/read failed or result is indeterminate** — migration/startup fails and MUST NOT create a competing canonical history.

A source may report definitive absence only when its lifecycle semantics make that answer suitable for first-creator selection. If concurrent would-be creators cannot be safely distinguished, the result is indeterminate rather than permission for both to create.

If two distinct canonical bootstrap artifacts are nevertheless discovered for one cohort, that is an unsupported bootstrap fork requiring explicit operator recovery; Journal synchronization does not merge them by payload equality.

The only remote dependency is availability of the canonical bootstrap artifact; no particular host needs to reconcile, acknowledge, or return, per `$id-4719065396881648`.

## Bootstrap-target compatibility

Each supported legacy->Journal transition has one expected **bootstrap target version/schema**.

Before interpreting a canonical artifact, joining lifecycle code requires exact equality:

```text
canonical.databaseVersion  == expectedBootstrapTargetVersion
canonical.graphSchemeString == expectedBootstrapTargetGraphSchemeString
```

Mismatch is `JournalVersionCompatibilityError` and authors no history.

A cohort may have migrated far beyond this version. The canonical artifact nevertheless remains at the original bootstrap target version. A late legacy installation joins at that version, then runs the ordinary supported Journal-aware migration chain until it reaches the running current version before graph APIs are exposed.

This avoids mixed-format bootstrap and does not require rewriting the canonical artifact backwards from a later current database.

## Canonical bootstrap writer

The installation which receives the definite-absence/create outcome uses its existing durable `DatabaseFingerprint` as the author of the canonical semantic bootstrap.

Its Journal stream starts at zero and authors the semantic baseline below.

The canonical creator's bootstrap ValueEvents are allocated in nondecreasing `(modifiedAt, canonical NodeKey)` order.

## Bootstrap authority for legacy value occurrences

A `ValueEvent(reason="bootstrap")` which converts a pre-Journal legacy value occurrence uses historical legacy authority:

```text
authorityTime = {
    physical: canonical(modifiedAt),
    logical: 0
}
```

rather than migration execution time.

For the canonical creator these records form its initial local stream.

For a joining installation, a locally different legacy occurrence is intentionally represented as **concurrent** with canonical bootstrap value occurrences. The joiner's bootstrap ValueEvent therefore does not include the canonical creator's bootstrap records in its cross-writer context merely because migration code read the canonical artifact. Its context contains its exact preceding local writer prefix and no synthetic foreign causality.

Joining bootstrap ValueEvents are likewise allocated in nondecreasing `(modifiedAt, canonical NodeKey)` order so same-writer sequence order never contradicts their authority order.

This is a controlled historical-conversion exception: bootstrap value context represents legacy semantic causality, not the migration procedure's read order. Later bootstrap Validate/Invalidate records return to normal causal-context/HLC allocation after the canonical cut and all local bootstrap ValueEvents they depend on are retained.

No ordinary pull, sync, reset, or later Journal-aware migration may use this exception.

## Canonical bootstrap Pass 1: value occurrences

For every materialized node K in the canonical bootstrap-target graph, author:

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

The frontier after this pass is the canonical `bootstrapFrontier` and is frozen as the cohort artifact before ordinary Journal authoring begins.

## Joining the canonical bootstrap

A joining installation keeps its **own** existing `DatabaseFingerprint`; it never clones the canonical creator's local writer identity.

A joining installation with the same fingerprint as the canonical creator is not a second bootstrap writer; it must use the same-installation restore/recovery path instead. Independently live clones of one writer identity remain unsupported.

Let:

```text
B  = held CanonicalBootstrapSnapshot
Jc = records(B) exactly through B.bootstrapFrontier
Pc = project(Jc, localWriter=joiningFingerprint)
Gl = joining installation's supported legacy graph interpreted for
     B.databaseVersion / B.graphSchemeString
```

`Gl` is the target-format legacy graph produced by the supported pre-Journal migration interpretation. It is not later current cohort state.

The join is a merge of two legacy snapshots, not a reset to `Gl`.

### Pass J1: establish legacy value occurrences without invented causality

For each node K materialized in `Gl`:

1. if `Pc` contains an occurrence with the same immutable semantic occurrence fields:

   ```text
   nodeIdentifier
   semantic payload
   createdAt
   modifiedAt
   ```

   then define:

   ```text
   localLegacyValueId(K) = Pc.valueId(K)
   ```

   and author no local ValueEvent;

2. otherwise author one joining-writer historical:

   ```text
   ValueEvent(reason="bootstrap")
   ```

   carrying K's legacy occurrence fields, with bootstrap authority seeded from K's own legacy `modifiedAt` and with no canonical-writer coordinate in its cross-writer context. Its ID becomes `localLegacyValueId(K)`.

A node present in `Pc` but absent from `Gl` does **not** cause a bootstrap DeleteEvent. Pre-Journal cache absence is not timestamped deletion evidence. As in legacy synchronization, a materialization present on only one side remains available.

A node present only in `Gl` gets its local bootstrap ValueEvent.

For a node present on both sides with different occurrences, the two ValueEvents are concurrent. Ordinary Journal `authorityCompare` therefore applies:

1. later `modifiedAt`-seeded authority wins;
2. writer fingerprint/sequence resolve the remaining Journal authority tie.

Upgrade time is never used to make the joining legacy occurrence causally newer.

### Pass J2: encode local proof/freshness evidence

After the canonical cut and all joining legacy ValueEvents are retained, author the joining host's bootstrap proof/freshness records under ordinary closed-context/HLC rules.

For each locally authored occurrence K, author a `ValidateEvent(reason="bootstrap")` whose basis represents the joining legacy graph's validity evidence:

```text
{ input: D, value: localLegacyValueId(D) }
```

when legacy `valid[D]` contains K, otherwise `"unknown"`.

If that local occurrence was stale, follow with a value-scoped `InvalidateEvent(reason="bootstrap")` for that local ValueId.

For an occurrence shared exactly with the canonical basis, do not author a second ValueEvent. If the joining legacy copy is stale while the canonical copy is fresh, author a value-scoped bootstrap invalidation for the shared canonical ValueId so same-occurrence stale evidence is conservative. If proof metadata requires a stricter conservative baseline, author only the required bootstrap proof events; they must not change the occurrence's ValueId.

Proof/freshness records may causally observe the canonical cut because they do not decide which conflicting legacy value occurrence wins.

### Pass J3: writer state and projection

Record the joining writer's own `last_node_index` with `WriterStateRecord` when not already represented.

Then replay the combined bootstrap history:

```text
Jjoined = Jc + joining bootstrap records
Pjoined = project(Jjoined, joiningFingerprint)
```

The postcondition is **not** `Pjoined == Gl` for conflicting value occurrences.

Instead:

- equal occurrences keep canonical ValueIds;
- local-only materializations survive;
- canonical-only materializations survive;
- conflicting occurrences are selected by normal Journal authority, principally legacy `modifiedAt`;
- proof/freshness follows replay of the retained evidence and conservative same-occurrence stale handling.

Thus a late host's local difference survives when it is non-conflicting or wins normal conflict authority; an older legacy value does not roll back a newer canonical value merely because its host upgraded later.

The resulting Journal/projection pair is atomically installed at the canonical bootstrap target version.

## Post-bootstrap history is not part of bootstrap join

A late join must never use records beyond `bootstrapFrontier` to construct `Pc` or to allocate bootstrap value contexts/authority.

If the canonical creator has since authored ordinary Journal history, that later history is imported only after bootstrap join through normal lifecycle steps:

1. finish the canonical join at the bootstrap target version;
2. run supported Journal-aware migrations until the local database reaches the running/current compatible version;
3. use ordinary `synchronizeFrom()` against compatible current sources.

For example, if C bootstrapped `K=v1`, later changed it to `v2`, and offline legacy J still has `v1`, J's canonical join sees only the frozen `v1` bootstrap cut and authors no replacement for K. Ordinary synchronization later imports C's post-bootstrap `v2`, which wins normally.

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

The existing migration decision is authoritative about whether the semantic occurrence survives.

### `keep`

`keep` preserves the current semantic occurrence. The selected ValueId remains unchanged.

### `override`

`override` is semantic-preserving by contract. It preserves the selected ValueId even if the target-version stored payload representation differs.

The target payload representation comes exclusively from the canonical per-record rewrite codec. The `override()` callback is checked against that codec result for the selected source record; it does not mutate that record independently.

The target selected occurrence therefore has:

```text
same ValueId
same semantic value
same NodeIdentifier
same createdAt
same modifiedAt
possibly different target-version payload bytes/structure
```

If the callback result differs from the canonical codec output, migration fails before cutover.

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
- canonical bootstrap join when the frozen artifact exists;
- indeterminate cohort bootstrap query fails without creating history;
- two competing canonical artifacts are detected as unsupported rather than payload-merged;
- canonical artifact exposes exactly the original bootstrap cut and never post-bootstrap records;
- canonical artifact version/schema exactly equal the supported bootstrap target;
- creator cannot begin ordinary Journal authoring before the canonical artifact is durably established;
- late host whose local occurrence equals canonical bootstrap occurrence authors no replacement even if the creator has later changed that node;
- creator post-bootstrap node creation is not interpreted as something the late legacy host should delete;
- local conflicting legacy occurrence is concurrent with the canonical occurrence and later `modifiedAt` wins independent of upgrade time;
- canonical newer `modifiedAt` beats an older late-host legacy occurrence;
- local-only legacy materialization survives bootstrap join;
- canonical-only legacy materialization survives bootstrap join;
- shared occurrence stale on either legacy side is conservatively stale after join;
- joining writer preserves its own fingerprint and allocation watermark;
- stale partial validity uses controlled `"unknown"`;
- after bootstrap join, later cohort history arrives only through ordinary compatible synchronization;
- a late host joins at the frozen bootstrap target version and then runs the normal Journal-aware migration chain when the cohort/current software has advanced;
- `keep` preserves ValueId;
- `override()` changes target representation while preserving ValueId and semantic meaning;
- pure per-record payload rewrite is identical for a retained ValueEvent regardless of whether that event is selected on the migrating replica;
- `override()` callback mismatch with the canonical codec output fails before cutover;
- two replicas where only one selects historical V still rewrite V identically and later synchronize without `JournalForkError`;
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
