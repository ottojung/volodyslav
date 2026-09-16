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

# Common Journal-aware migration rules

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

## What the canonical basis guarantees

Pre-Journal replicas have no `ValueId`s. If replicas independently converted every shared cache occurrence, equal legacy state would gratuitously become unrelated Journal identities.

The canonical bootstrap therefore establishes one shared identity basis for occurrences equal to the canonical cut. A joining replica which has the same immutable occurrence fields reuses the canonical `ValueId`.

The guarantee is deliberately narrower for **non-canonical** legacy occurrences. Two independent late joiners may both hold the same legacy occurrence which differs from the canonical cut. Each may convert that occurrence under its own writer and therefore assign a distinct bootstrap `ValueId`. After later synchronization one wins by normal authority and dependents naming the losing occurrence may become stale.

That limitation is explicitly accepted by `$id-1635227135166767`. Journal bootstrap does not add another pre-Journal identity-reconciliation protocol merely to deduplicate such non-canonical occurrences.

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
4. those compatibility fields are the bootstrap target database version/schema;
5. the artifact is immutable while a software release claims support for joining that bootstrap target;
6. an ordinary current `JournalSnapshot` is not a substitute merely because it contains the bootstrap records as a prefix.

The specification does **not** require every future release to retain an old bootstrap artifact decoder, the original legacy conversion, or every migration step from that historical target forever.

A running release supports canonical bootstrap join only when its configured expected bootstrap target version/schema exactly equals the artifact's `databaseVersion` / `graphSchemeString`. Otherwise it fails with `JournalVersionCompatibilityError` before authoring history. An operator wishing to recover a much older legacy installation must first use software which explicitly supports that historical bootstrap target, then upgrade through the ordinary supported lifecycle.

This artifact is lifecycle source state, not an additional record format inside an active JournalReplica. The one-current-format invariant still applies to every active database replica.

## Canonical bootstrap source decision

The lifecycle has one configured transport-neutral **cohort bootstrap source**, analogous to the installation recovery source.

Conceptually it returns:

```text
Exists(CanonicalBootstrapSnapshot)
DefinitelyAbsent
IndeterminateOrError
```

Exactly three outcomes are supported:

1. **canonical bootstrap artifact exists** — hold that immutable artifact and follow the creator-resume or joining path below;
2. **source definitively does not exist** — this installation may `createCanonicalBootstrap`;
3. **query/read failed or result is indeterminate** — migration/startup fails and MUST NOT create a competing canonical history.

A source may report definitive absence only when its lifecycle semantics make that answer suitable for first-creator selection. If concurrent would-be creators cannot be safely distinguished, the result is indeterminate rather than permission for both to create.

If two distinct canonical bootstrap artifacts are nevertheless discovered for one cohort, that is an unsupported bootstrap fork requiring explicit operator recovery; Journal synchronization does not merge them by payload equality.

No particular peer must reconcile, acknowledge, or return merely for bootstrap to complete, per `$id-4719065396881648`. The configured source only needs to provide the canonical artifact for releases which claim support for this bootstrap target.

## Bootstrap-target compatibility

Before interpreting the artifact, lifecycle code requires:

```text
canonical.databaseVersion   == expectedBootstrapTargetVersion
canonical.graphSchemeString == expectedBootstrapTargetGraphSchemeString
```

and the running release must explicitly support that target as its legacy->Journal bootstrap target.

Mismatch is `JournalVersionCompatibilityError` and authors no history.

Bootstrap join itself does not define a permanent cross-version compatibility ladder. After a successful bootstrap cutover, the ordinary migration gate may run whatever later migrations the running release actually supports.

## Canonical bootstrap writer and publication order

The installation which receives the definite-absence/create outcome uses its existing durable `DatabaseFingerprint` as the author of the canonical semantic bootstrap.

Its Journal stream starts at zero and authors the semantic baseline below.

`createCanonicalBootstrap` durably establishes the immutable canonical artifact before it reports success and before ordinary post-bootstrap Journal authoring is enabled. Local active-replica cutover may still fail after the artifact becomes durable; the creator-resume path below exists specifically for that crash window.

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

## Canonical bootstrap passes

### Pass C1: value occurrences

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

### Pass C2: validation baseline

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

### Pass C3: stale state

For every canonical legacy stale K, author:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "value", value: bootstrapValueId(K) },
    reason: "bootstrap"
}
```

after its bootstrap certificate.

### Pass C4: creator writer state

Record the creator's legacy allocation watermark with a `WriterStateRecord`.

The frontier after this pass is the canonical `bootstrapFrontier` and is frozen as the cohort artifact before ordinary Journal authoring begins.

## Creator resume after artifact publication

There is one special recovery case between creation and local cutover.

If startup sees all of the following:

```text
local state is still supported pre-Journal state
artifact.creatorWriter == local DatabaseFingerprint
artifact version/schema == expected bootstrap target
```

then this installation is the canonical creator resuming an interrupted bootstrap. It MUST NOT join as a foreign writer and MUST NOT create another canonical history.

Conceptually:

```text
resumeCanonicalBootstrapCreator(legacyState, artifact)
```

performs:

1. read exactly the artifact records through `bootstrapFrontier`;
2. project them with `localWriter = artifact.creatorWriter`;
3. independently interpret the still-local legacy database into the same bootstrap-target semantic graph;
4. require semantic equality between that graph and the artifact projection, including presence, payloads, NodeIdentifiers, timestamps, freshness, and validity;
5. if they differ, fail with `JournalBootstrapForkError` and author/cut over nothing;
6. if they agree, install exactly the artifact records as the local Journal stream without allocating any new semantic record;
7. reconstruct local writer head, `last_node_index`, authority high-water, projection, and derived indexes from the artifact;
8. atomically cut over to the bootstrap-target Journal/projection pair;
9. continue the ordinary migration gate from that installed version if the running release has another supported step.

This path is valid only for the artifact's own `creatorWriter`. A different fingerprint uses the ordinary joining path below.

The equality check prevents a local legacy database which changed after artifact publication from silently continuing the creator's writer history as if it were the same bootstrap state.

## Joining the canonical bootstrap

A joining installation keeps its **own** existing `DatabaseFingerprint`; it never clones the canonical creator's local writer identity.

If its fingerprint equals `creatorWriter`, it uses creator resume above rather than this path.

Let:

```text
B  = held CanonicalBootstrapSnapshot
Jc = records(B) exactly through B.bootstrapFrontier
Pc = project(Jc, localWriter=joiningFingerprint)
Gl = joining installation's supported legacy graph interpreted for
     B.databaseVersion / B.graphSchemeString
```

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

   then reuse `Pc.valueId(K)` and author no local ValueEvent;

2. otherwise author one joining-writer historical `ValueEvent(reason="bootstrap")` carrying K's legacy occurrence fields, with authority seeded from K's own legacy `modifiedAt` and with no canonical-writer coordinate in its cross-writer context.

A node present in `Pc` but absent from `Gl` does **not** cause a bootstrap DeleteEvent. Pre-Journal cache absence is not timestamped deletion evidence. As in legacy synchronization, a materialization present on only one side remains available.

A node present only in `Gl` gets its local bootstrap ValueEvent.

For a node present on both sides with different occurrences, the two ValueEvents are concurrent. Ordinary Journal `authorityCompare` applies:

1. later `modifiedAt`-seeded authority wins;
2. writer fingerprint/sequence resolve the remaining tie.

Upgrade time is never used to make the joining legacy occurrence causally newer.

Two different joiners which happen to carry the same non-canonical occurrence may create distinct ValueIds for it. That is the accepted bootstrap identity trade-off `$id-1635227135166767`; no extra deduplication by payload/timestamp equality is performed across independent joining writers.

### Pass J2: encode local proof/freshness evidence

After the canonical cut and all joining legacy ValueEvents are retained, author the joining host's bootstrap proof/freshness records under ordinary closed-context/HLC rules.

For each locally authored occurrence K, author a `ValidateEvent(reason="bootstrap")` whose basis represents the joining legacy graph's validity evidence:

```text
{ input: D, value: localLegacyValueId(D) }
```

when legacy `valid[D]` contains K, otherwise `"unknown"`.

If that local occurrence was stale, follow with a value-scoped `InvalidateEvent(reason="bootstrap")` for that local ValueId.

For an occurrence shared exactly with the canonical basis, do not author a second ValueEvent. If the joining legacy copy is stale while the canonical copy is fresh, author a value-scoped bootstrap invalidation for the shared canonical ValueId so same-occurrence stale evidence is conservative. Proof-only differences may add bootstrap proof history but do not change the occurrence's ValueId.

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
- proof/freshness follows replay of retained evidence and conservative same-occurrence stale handling.

Thus a late host's local difference survives when it is non-conflicting or wins normal conflict authority; an older legacy value does not roll back a newer canonical value merely because its host upgraded later.

The resulting Journal/projection pair is atomically installed at the bootstrap target version.

## Post-bootstrap history is not part of bootstrap join

A join must never use records beyond `bootstrapFrontier` to construct the canonical projection or to allocate bootstrap value contexts/authority.

If the release performing bootstrap is also able to migrate onward, it does so only **after** the bootstrap-target pair is installed, through its ordinary explicit migration gate.

Post-bootstrap cohort history is imported only after the installation has reached a compatible current version and then runs ordinary `synchronizeFrom()`.

Journal 3 does not require arbitrary future software to preserve this old join path indefinitely.

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

### `keep`

`keep` preserves the current semantic occurrence. The selected ValueId remains unchanged.

### `override`

`override` is semantic-preserving by contract. It preserves the selected ValueId even if target-version stored payload representation differs.

The target payload representation comes exclusively from the canonical per-record rewrite codec. The `override()` callback is checked against that codec result for the selected source record; it does not mutate that record independently.

If the callback result differs from the canonical codec output, migration fails before cutover.

### `invalidate`

`invalidate` preserves the cached semantic occurrence and ValueId, marks it stale, and removes its incoming proof according to the migration framework. It does not itself create a new ValueEvent.

### `delete`

`delete` establishes absence with `DeleteEvent(reason="migration")` when the converted history still selects a value.

### `create`

`create` establishes a genuinely new occurrence and therefore authors a new `ValueEvent(reason="migration")` with a new ValueId.

Any other migration operation which explicitly creates/replaces the semantic value occurrence likewise creates a new ValueEvent. Merely changing schema, proof, freshness, database version, or serialized representation does not.

## Independent migration of genuine replacement occurrences

Two replicas may independently run the same Journal-aware migration. If the migration genuinely creates/replaces an occurrence, each replica may author its own new ValueEvent for that occurrence.

After later synchronization one occurrence wins by normal Journal conflict authority. A dependent whose certificate names the losing replacement ValueId may become stale and recompute/revalidate. This is accepted by `$id-1270770443138081` rather than requiring one remote canonical migration participant.

Occurrence-preserving migrations—including `keep`, `override`, proof-only changes, freshness-only changes, and representation-only whole-history rewrites—retain already-shared ValueIds.

## Migration observation cut

The semantic migration observes one complete source frontier:

```text
Fmigrate = frontier(Jbefore) = frontier(Jconverted)
```

Every ordinary migration-authored semantic repair event is causally after that closed frontier plus earlier same-migration records it references.

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

For every K in `BeforePresent - TargetPresent`, author exactly one required `DeleteEvent(reason="migration")` unless converted history already selects absence.

Call replay after Pass 1 `P1`.

## Migration Pass 2: establish exact target proof

For each target-present K define:

```text
CurrentValid(K) = {
    D | P1 contains semantic validity edge D -> K
}

TargetValid(K) = {
    D | Gtarget contains semantic validity edge D -> K
}
```

### Proof weakening barrier

Replay intentionally selects the certificate with greatest `basisMatchCount` before authority. A later partial certificate therefore cannot by itself remove validity supplied by an older stronger certificate.

Whenever migration must remove at least one currently-valid incoming edge:

```text
CurrentValid(K) - TargetValid(K) != empty
```

migration MUST first author:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "node" },
    reason: "migration"
}
```

This is the **migration proof barrier**. Every certificate predating the barrier becomes ineligible. A later migration validation can then establish the exact weaker/partial target proof.

The barrier is required for proof weakening/removal, including:

- explicit `invalidate(K)`, whose target removes K's incoming validity;
- stale `keep`/`override` regions where the existing migration contract discards incoming proofs; and
- any schema/target proof transition which removes a current validity edge while preserving K's ValueId.

If migration only adds validity, no barrier is required solely for that addition because the later certificate has at least as strong a basis and wins normally.

After any required barrier, migration MAY reuse an existing eligible current-shape certificate only when replay already yields exactly `TargetValid(K)` and the certificate has the causal coverage required for target freshness.

Otherwise author one causally-later migration `ValidateEvent` targeting `targetValueId(K)`:

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

Use `targetValueId(D)` exactly when D is in `TargetValid(K)`; otherwise use `"unknown"`.

If a barrier was authored, this validation occurs after it. Even an all-`"unknown"` target certificate can therefore represent zero incoming target validity without an older full certificate re-winning by basis-match count.

Call replay after Pass 2 `P2`.

## Migration Pass 3: establish persistent target freshness

For each present K let C be the replay-selected certificate in P2 and define:

```text
selfProofReady(K) iff
    C exists
    and basisMatchCount(K,C) == numberOfDirectInputs(K)
    and coversValueInvalidations(K,C)
```

Node-scoped invalidation coverage is already part of certificate eligibility.

For target-fresh K, final replay must make K fresh; any observed invalidation that would prevent this is covered by the causally later target validation rather than by replacing K's ValueId.

For target-stale K:

- if an uncovered value-scoped invalidation already targets `targetValueId(K)`, do not duplicate it;
- otherwise, if `selfProofReady(K)` is true, author:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "value", value: targetValueId(K) },
    reason: "migration"
}
```

This rule is intentionally stronger than “only if replay would otherwise be fresh.” If K's own proof is ready but K is currently stale only because a direct input is stale, the value-scoped marker is still required whenever `Gtarget` stores K as stale. Otherwise a later `Unchanged` revalidation of that input could make K fresh automatically, losing the migration framework's persistent propagated-stale flag.

If `selfProofReady(K)` is false, K already has a persistent own-state reason for staleness (basis mismatch, node invalidation, or current-value invalidation), so no extra marker is required merely to duplicate it.

Thus migration reproduces both target proof edges and the persistence behavior of target freshness without manufacturing a replacement ValueEvent.

## Migration writer state

Migration preserves continuing writer identity/sequence and retained foreign histories.

Representation rewriting must not reset or renumber Journal positions or semantic authority coordinates.

The local NodeIdentifier allocation watermark may stay the same or advance according to target migration. If its durable value changes, record the resulting local watermark with `WriterStateRecord`.

## Migration postcondition

Before cutover:

```text
target global/version == targetVersion
all retained Journal records use targetVersion canonical format
old JournalRecordIds are preserved
project(Jafter, targetSchema) == Gtarget
```

The target Journal/projection pair becomes active atomically.

The equivalence includes persistence of stale flags: a migration-propagated stale dependent does not become fresh merely because an upstream node later returns `Unchanged`; the dependent itself must validate/recompute.

Failure before cutover leaves the old source-version pair selected.

## Synchronization across migration

Ordinary synchronization requires compatible current database/schema interpretation and compatible current record format.

Replicas at different versions do not ordinary-sync until each has independently reached a compatible target interpretation through a supported migration path.

Shared pre-migration records independently rewritten through the same format migration compare identically after rewrite.

Migration-authored new semantic records synchronize like any other immutable history. If independently migrating replicas created distinct replacement occurrences, ordinary head/certificate/freshness rules handle the resulting conflict and possible downstream staleness.

No particular peer must have participated in migration or return later.

## Historical certificates after schema change

Old ValidateEvents remain intelligible historical evidence because their input NodeKeys are explicit.

Current replay uses an old certificate only when:

- it targets the selected current ValueId;
- its explicit input-key set equals the current target input set;
- ordinary invalidation/certificate-selection rules accept it.

When migration needs weaker proof, the proof barrier above intentionally makes stronger pre-migration certificates ineligible before the target certificate is authored.

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

### Bootstrap lifecycle

- canonical bootstrap creation when the cohort bootstrap source is definitively absent;
- canonical bootstrap join when a compatible frozen artifact exists;
- indeterminate query fails without creating history;
- competing canonical artifacts are rejected;
- artifact exposes exactly the original bootstrap cut and never post-bootstrap records;
- artifact version/schema mismatch with the running release's expected bootstrap target fails with `JournalVersionCompatibilityError` before authoring history;
- future releases are not required to retain an unsupported historical bootstrap target;
- creator crash after artifact publication but before local cutover resumes from the exact artifact when `creatorWriter` equals the local fingerprint and legacy state still matches;
- creator-resume semantic mismatch fails with `JournalBootstrapForkError` and authors nothing;
- a different fingerprint cannot use creator-resume;
- late host whose local occurrence equals canonical occurrence reuses canonical ValueId;
- local conflicting legacy occurrence is concurrent with canonical occurrence and later `modifiedAt` wins independent of upgrade time;
- canonical newer `modifiedAt` beats an older late-host occurrence;
- local-only and canonical-only materializations both survive bootstrap merge;
- two late joiners carrying the same non-canonical occurrence may produce distinct bootstrap ValueIds; after synchronization a dependent naming the losing occurrence may become stale, per `$id-1635227135166767`;
- joining writer preserves its own fingerprint/watermark;
- stale partial validity uses controlled `"unknown"`.

### Journal-aware migration

- `keep` preserves ValueId;
- pure per-record format rewrite is identical regardless of selected/non-selected status;
- `override()` preserves ValueId and mismatch with canonical codec fails before cutover;
- `invalidate()` preserves cached ValueId while removing incoming target validity;
- old full certificate followed by target weaker/no proof uses a node-scoped proof barrier and the old certificate cannot win replay;
- stale `keep`/`override` proof weakening likewise removes unwanted old validity;
- proof-only/freshness-only/schema-only changes do not create ValueEvent;
- migration `A -> B`, both fresh, then `invalidate(A)` persists propagated stale B so revalidating A `Unchanged` does not freshen B;
- `create()` or true semantic replacement creates a new ValueId;
- independently migrated true replacement occurrences may differ in ValueId and stale dependents later;
- target replay equals migration target;
- whole-history rewrite preserves old IDs/references/causal meaning;
- failure before cutover leaves source selected;
- future replay does not run historical migration callbacks.

## Non-goals

This specification does not define Git branch mechanics, a hosted synchronization backend, SQL/HTTP APIs, deployment orchestration, or another transport protocol.
