# IncrementalGraph Journal 3 Bootstrap and Migration

## Purpose

This document specifies two distinct lifecycle transitions:

1. **pre-Journal bootstrap** — convert an already-supported persisted legacy graph into replay-complete Journal history without changing that graph's semantics; and
2. **Journal-aware migration** — migrate an existing Journal database to another database/schema version while retaining historical identity.

Both must preserve the core invariant:

```text
persistedGraph == project(retainedJournal)
```

The central occurrence-identity rule is:

> A new `ValueId` is created only when a semantic value occurrence is genuinely created or replaced. Database-version, schema, representation, proof, or freshness changes alone do not create a new occurrence.

Representation-only changes to retained Journal history are performed by one canonical whole-history format codec.

---

# Part I — Pre-Journal bootstrap

## 1. Bootstrap is semantic identity, not graph migration

Bootstrap records the **already-persisted supported legacy graph** as Journal history.

At the bootstrap cut it preserves exactly:

- materialized semantic NodeKeys;
- NodeIdentifiers;
- payload semantics;
- `createdAt` / `modifiedAt`;
- freshness;
- validity edges;
- `last_node_index`; and
- graph interpretation/schema semantics.

The bootstrap target may use a new database representation/version because Journal storage is introduced, but the graph semantics at that cut are unchanged.

Bootstrap therefore does not execute ordinary semantic migration decisions before Journal identity exists. In particular it does not create/delete/invalidate target graph state, synthesize new timestamps or identifiers, consult randomness/wall clock, or perform another schema-semantic transformation to manufacture the bootstrap target.

If reaching the proposed bootstrap target would require such a transformation, that source/target pair is unsupported and startup fails `JournalVersionCompatibilityError` before authoring bootstrap history.

Actual graph/schema/representation migration happens either:

- before entering the supported pre-Journal source state, using software which owns that older transition; or
- after bootstrap, through the Journal-aware migration rules in Part II.

## 2. Why one canonical bootstrap basis exists

Pre-Journal replicas have no `ValueId`s. If every replica independently converted identical shared cache occurrences, those occurrences would receive unrelated Journal identities.

The canonical bootstrap artifact establishes a shared `ValueId` basis for every legacy occurrence equal to the canonical cut.

This guarantee is intentionally limited. If two late joiners both carry the same occurrence which differs from the canonical cut, each may author its own historical bootstrap ValueEvent and receive a distinct ValueId. Later synchronization may therefore stale dependents naming the losing occurrence. This accepted trade-off is `$id-1635227135166767`.

## 3. Canonical bootstrap artifact

The canonical bootstrap artifact is the **original frozen bootstrap cut**, not an arbitrary current Journal snapshot.

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

Required properties:

1. `bootstrapFrontier` is the creator frontier immediately after canonical bootstrap and before ordinary post-bootstrap Journal operations;
2. the artifact exposes exactly records through that frontier and no later history;
3. the cut is causally closed and replayable under its stored version/schema;
4. the artifact is immutable while the running release claims support for that bootstrap target; and
5. a current `JournalSnapshot` containing the same records as a prefix is not a substitute.

A release supports joining an artifact only when:

```text
artifact.databaseVersion   == expectedBootstrapTargetVersion
artifact.graphSchemeString == expectedBootstrapTargetGraphSchemeString
```

Otherwise bootstrap fails `JournalVersionCompatibilityError` before authoring history.

No permanent decoder/migration ladder for every historical artifact is required.

## 4. Canonical bootstrap source decision

The configured transport-neutral `CohortBootstrapSource` yields exactly one of:

```text
Exists(CanonicalBootstrapSnapshot)
DefinitelyAbsent
IndeterminateOrError
```

Semantics:

1. **Exists** — hold the immutable artifact and use creator-resume or ordinary join according to writer identity;
2. **DefinitelyAbsent** — canonical creation is allowed only when the source's arbitration semantics make this a safe first-creator decision;
3. **IndeterminateOrError** — fail and MUST NOT create competing canonical history.

Distinct canonical artifacts for one cohort are unsupported bootstrap forks requiring explicit recovery; they are not payload-merged.

No particular peer must reconcile, acknowledge, or return merely for bootstrap to finish, consistent with `$id-4719065396881648`.

## 5. Canonical creator records

The canonical creator uses its existing durable `DatabaseFingerprint` as `JournalAuthor` and starts its Journal at frontier zero.

### 5.1 Legacy value authority

Each bootstrap ValueEvent converts one existing legacy occurrence and uses historical legacy authority:

```text
authorityTime = {
    physical: canonical(modifiedAt),
    logical: 0
}
```

Canonical bootstrap ValueEvents are allocated in nondecreasing:

```text
(modifiedAt, canonical NodeKey)
```

so same-writer sequence order does not contradict authority ordering.

### 5.2 Pass C1 — values

For every materialized legacy node K author:

```text
ValueEvent {
    node: K,
    nodeIdentifier: legacyNodeIdentifier(K),
    payload: legacyPayload(K),
    createdAt: legacyCreatedAt(K),
    modifiedAt: legacyModifiedAt(K),
    reason: "bootstrap"
}
```

Call its ID `bootstrapValueId(K)`.

All canonical ValueEvents precede canonical validation events.

### 5.3 Pass C2 — validation baseline

For every materialized K author one self-describing:

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

with exactly one entry per direct legacy input in canonical persisted NodeKey order.

Use `bootstrapValueId(D)` exactly when legacy validity contains edge `D -> K`; otherwise use `"unknown"`.

### 5.4 Pass C3 — stale state

For every legacy-stale K author, after its certificate:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "value", value: bootstrapValueId(K) },
    reason: "bootstrap"
}
```

### 5.5 Pass C4 — writer state

Record the creator's legacy `last_node_index` using `WriterStateRecord`.

The resulting frontier is frozen as `bootstrapFrontier` and durably published as the canonical artifact **before** ordinary post-bootstrap authoring is enabled.

## 6. Creator resume after artifact publication

A crash may occur after the canonical artifact is durable but before the creator has cut over its local active database.

If:

```text
local state is still supported pre-Journal state
artifact.creatorWriter == local DatabaseFingerprint
artifact target version/schema is supported
```

startup uses:

```text
resumeCanonicalBootstrapCreator(legacyState, artifact)
```

It:

1. reads exactly artifact records through `bootstrapFrontier`;
2. projects them using `artifact.creatorWriter` as local writer;
3. compares that projection directly with still-persisted legacy semantics;
4. reruns no migration callback and regenerates no timestamp/identifier;
5. requires equality of presence, payloads, NodeIdentifiers, timestamps, freshness, validity, and allocator state required by bootstrap;
6. on mismatch fails `JournalBootstrapForkError` without authoring/cutover;
7. on equality installs exactly artifact history, reconstructs writer head/allocator/authority/projection/indexes, and atomically cuts over; and
8. resumes the ordinary migration gate from the installed Journal version.

A different fingerprint cannot use creator-resume.

## 7. Joining the canonical bootstrap

A joining installation keeps its own fingerprint/writer identity.

Let:

```text
B  = held CanonicalBootstrapSnapshot
Jc = exactly records(B) through B.bootstrapFrontier
Pc = project(Jc, localWriter=joiningFingerprint)
Gl = validated persisted joining legacy graph
```

`Gl` is read directly from supported persisted legacy state. It is not produced by rerunning a legacy migration to B's target.

The join is a historical merge, **not reset**.

### 7.1 Historical ValueEvent context exception

A joining host may physically read the canonical artifact while converting a different pre-existing legacy occurrence. That read does not make the old legacy occurrence causally later than the canonical occurrence.

Therefore a locally different bootstrap ValueEvent:

- has exact own-writer prefix context;
- omits synthetic canonical-writer causality;
- remains concurrent with the conflicting canonical value; and
- uses authority seeded from its own legacy `modifiedAt`.

This exception is only for historical pre-Journal value conversion. Later bootstrap proof/stale records use ordinary closed contexts.

### 7.2 Pass J1 — establish value occurrences

For every K materialized in `Gl`, define `joiningOccurrenceValueId(K)` as the Journal identity of the **joining host's own legacy occurrence**:

- if `Pc` contains the same immutable occurrence fields (`NodeIdentifier`, semantic payload, `createdAt`, `modifiedAt`), set `joiningOccurrenceValueId(K) = Pc.valueId(K)` and author no ValueEvent;
- otherwise author one joining-writer historical `ValueEvent(reason="bootstrap")` carrying the persisted legacy occurrence fields and set `joiningOccurrenceValueId(K)` to that new ValueEvent ID.

All joining historical ValueEvents are allocated in nondecreasing:

```text
(modifiedAt, canonical NodeKey)
```

order. This is the same writer-local authority rule as canonical bootstrap and prevents writer sequence from contradicting bootstrap AuthorityTime.

All joining historical ValueEvents are allocated before any joining Validate/Invalidate/WriterState record whose context includes the canonical-writer bootstrap cut. Thus later proof/stale records can causally reference any joining legacy occurrence even when that occurrence is not selected after conflict resolution.

A node present in `Pc` but absent from `Gl` does **not** cause a DeleteEvent. Legacy cache absence is not timestamped deletion evidence.

A local-only node gets a joining bootstrap ValueEvent.

Different occurrences on both sides are concurrent and selected by ordinary Journal authority, principally legacy `modifiedAt`, then deterministic writer/sequence tie-breaks. Upgrade time contributes no precedence.

### 7.3 Pass J2 — local proof and direct stale evidence

#### Locally authored occurrences

For each locally authored selected occurrence K, author a bootstrap ValidateEvent whose basis records the **historical proof actually present in the joining legacy graph**.

For every direct input D:

- if joining legacy validity contains `D -> K`, use `joiningOccurrenceValueId(D)`;
- otherwise use `"unknown"`.

Do **not** substitute the currently selected bootstrap ValueId of D merely because another D occurrence won conflict selection.

Consequently, if the joining host's D occurrence loses to a different canonical/current D occurrence, K's basis still names the joining D occurrence it was actually validated against. Replay then observes the basis mismatch against selected D and K is hard stale rather than manufacturing a validity edge for a combination no legacy replica ever possessed.

If that local K occurrence was stale, follow its validation with `value(V)` bootstrap invalidation.

#### Exact shared occurrences

For an exact occurrence shared with the canonical basis, keep the canonical ValueId and merge positive proof by conservative intersection:

```text
CanonicalValid(K) = canonical semantic validity edges into K
JoiningValid(K)   = joining legacy validity edges into K
JoinedValid(K)    = CanonicalValid(K) intersect JoiningValid(K)
```

The canonical certificate remains the positive basis. Joining-only proof never strengthens it.

For every:

```text
D in CanonicalValid(K) - JoiningValid(K)
```

author:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "proof", value: Pc.valueId(K), input: D },
    reason: "bootstrap"
}
```

No joining ValidateEvent is authored merely to strengthen proof for an exact shared occurrence.

Shared stale state is symmetric/conservative:

```text
joinedSharedStale(K) =
    canonicalStale(K) OR joiningStale(K)
```

After proof-edge barriers, ensure an **uncovered**:

```text
Invalidate(K, scope=value(Pc.valueId(K)), reason="bootstrap")
```

exists whenever `joinedSharedStale(K)` is true.

Thus a fresh joiner cannot clear canonical stale evidence, and a stale joiner can stale a canonical-fresh shared occurrence without changing its ValueId.

### 7.4 Pass J2b — persist recursive-only staleness

After direct proof/stale roots, process present nodes in deterministic dependency-topological order.

For each K, let C be its replay-selected certificate and define:

```text
selfProofReady(K) iff
    C exists
    and effectiveBasisMatchCount(K,C) == numberOfDirectInputs(K)
    and coversValueInvalidations(K,C)
```

If `selfProofReady(K)` and some direct input is stale, ensure an uncovered:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "value", value: currentValueId(K) },
    reason: "bootstrap"
}
```

exists.

Because the schema is acyclic, one input-to-dependent topological pass reaches the required fixed point. A later upstream `Unchanged` cannot silently freshen such a dependent.

### 7.5 Pass J3 — joining writer state and cutover

Record the joining writer's `last_node_index` using `WriterStateRecord` when needed.

Then:

```text
Jjoined = Jc + joining bootstrap records
Pjoined = project(Jjoined, joiningFingerprint)
```

Required result:

- canonical-equal occurrences share canonical ValueIds;
- local-only and canonical-only materializations survive;
- conflicting values are selected by normal authority;
- local proof names the joining legacy occurrences it actually depended on, so mixed conflict winners cannot manufacture fresh cross-replica combinations;
- exact-shared validity is the proof intersection;
- exact-shared stale evidence is conservative across both sides;
- recursive-only stale transitions are persisted; and
- joining fingerprint/allocator state remains local.

`Pjoined` need not equal `Gl` when value conflicts exist; local differences survive when non-conflicting or when they win ordinary authority.

The Journal/projection pair is atomically installed at the bootstrap target version.

### 7.6 Late join versus unseen post-bootstrap revalidation

Bootstrap intentionally uses only the frozen canonical cut. A joining host's J2 proof barriers and stale markers therefore cannot observe post-bootstrap cohort validations which occurred after that cut but before the late host upgraded.

When those later cohort records are eventually imported, such a validation is concurrent with the joining proof/stale evidence and does not retroactively cover it. The affected occurrence may therefore become stale again or lose an incoming proof edge until a validation **causally after the late join evidence** re-proves it.

This conservative behavior is intentional. Legacy state does not contain enough causal/timestamp information for invalidation/proof changes to soundly assert that an unseen cohort revalidation happened after the joining host's legacy negative evidence. Preferring freshness would risk discarding a real legacy invalidation; the accepted cost is possible redundant revalidation/recomputation after a late join.

## 8. Post-bootstrap history is not bootstrap input

Bootstrap join never uses records beyond `bootstrapFrontier` to construct the canonical basis or historical joining-value causality.

After bootstrap target installation:

1. run any explicitly supported Journal-aware migrations required by the release;
2. reach a version/schema compatible with peers; and only then
3. import post-bootstrap history through ordinary synchronization.

---

# Part II — Journal-aware migration

## 9. Principle

Start from:

```text
Gbefore = project(Jbefore, sourceSchema)
```

First rewrite **all retained history** into the target representation using the directed source->target `JournalFormatCodec` defined in `migration.md`:

```text
Jconverted = rewriteJournalFormat(
    Jbefore,
    sourceVersion,
    targetVersion,
    journalFormatCodec
)
```

For semantic-repair bookkeeping, also define a conceptual target-key view of the pre-migration projection:

```text
GconvertedBefore =
    transportProjectionThroughCodec(
        Gbefore,
        journalFormatCodec
    )
```

For every source-present semantic node `Ks`, let `Kt = rewriteNodeKey(Ks)`. `GconvertedBefore` represents that same selected occurrence under `Kt` and preserves its `ValueId`, `NodeIdentifier`, timestamps, freshness, and occurrence identity; payload representation is rewritten with `rewriteComputedValue(Ks,...)`, and dependency/validity endpoints are rewritten through `rewriteNodeKey`.

This is a conceptual bookkeeping view, not a second persisted migration and not a replay under the target semantic schema. It expresses the **source semantic state in target NodeKey representation** before semantic migration decisions are applied.

Then compute semantic target graph `Gtarget` and append only records required so:

```text
Jafter = Jconverted + migration-authored records
project(Jafter, targetSchema) == Gtarget
```

From this point onward, semantic-repair key comparisons and occurrence-preservation lookups operate in the target key space represented by `GconvertedBefore` and `Gtarget`; they do not directly index source-keyed `Gbefore` by a target NodeKey.

Replicas migrate independently; no canonical migration participant is required.

## 10. One-format / total-codec invariant

An active source replica is entirely source-format. The inactive target replica is entirely target-format. Journal records carry no per-record format selector.

For every retained source record R with ID `(A,q)`, the source->target migration defines exactly one deterministic target-format record with the **same ID and historical meaning**.

The normative codec contract and rewrite pipeline are in `migration.md` §Journal format codec. In summary, the rewrite:

1. decodes under the source version;
2. applies deterministic `rewriteNodeKey` to every embedded NodeKey;
3. requires `rewriteNodeKey` to be injective over all distinct source NodeKeys occurring in retained history, so two historical semantic nodes cannot collapse onto one target key;
4. applies deterministic `rewriteComputedValue` to every retained ValueEvent payload;
5. preserves Journal IDs, sequence, causal/reference identity, AuthorityTime meaning, NodeIdentifiers, and timestamps;
6. re-canonicalizes target structures, including re-sorting ValidationBasis entries by target canonical NodeKey order; and
7. encodes under the target version.

The codec domain is **all retained source-version history**, including non-selected occurrences and historical records for node families absent from the target schema.

If any retained source record lacks a deterministic valid target representation, migration fails:

```text
JournalVersionCompatibilityError
```

**before cutover**. It must not drop, guess, or classify that history as an ordinary migration-decision failure.

Whole-history work proportional to retained Journal size is accepted and should be streamable where practical.

## 11. Migration decision semantics

The semantic migration vocabulary is:

```text
keep
invalidate
delete
create
```

plus whatever explicit future create/replace operation is separately specified.

### `keep`

Preserves the selected semantic occurrence and therefore its ValueId, timestamps, freshness, and every source-replay incoming validity edge whose certificate remains current-shape-compatible under the target input set.

A stale kept occurrence does **not** lose proof merely because it is stale. Journal history already distinguishes node invalidation, value-scoped stale state, proof-edge barriers, and recursive staleness. If target schema removes/changes an input edge, the resulting shape/proof difference is handled explicitly by M2 rather than by a generic stale-node heuristic.

Representation-only changes for that occurrence come from the canonical whole-history codec.

### `invalidate`

Preserves cached occurrence/ValueId, marks the node stale, and removes its incoming proof according to the migration framework.

Because this is genuine explicit node invalidation, Journal authors:

```text
Invalidate(K, scope=node, reason="migration")
```

### `delete`

If converted history still selects a value, establish absence using:

```text
DeleteEvent(reason="migration")
```

### `create` / true replacement

A genuinely new/replaced semantic occurrence receives a new:

```text
ValueEvent(reason="migration")
```

and therefore a new ValueId.

Schema/proof/freshness/database-format changes alone do not create a new ValueEvent.

## 12. Independent genuine replacements

Two replicas may independently perform the same semantic migration and create different ValueIds for a genuinely replaced occurrence.

After later synchronization, ordinary conflict authority selects one. Dependents naming a losing replacement may stale/revalidate/recompute. `$id-1270770443138081` accepts this trade-off rather than requiring a remote canonical migration author.

Occurrence-preserving changes retain already-shared ValueIds.

## 13. Migration observation cut

Semantic repair observes one complete converted source frontier:

```text
Fmigrate = frontier(Jbefore) = frontier(Jconverted)
```

Migration-authored semantic events are causally after that closed frontier plus earlier same-migration records they reference.

## 14. Migration domain

Let:

```text
ConvertedBeforePresent = present keys in GconvertedBefore
TargetPresent          = present keys in Gtarget
MigrationDomain        = ConvertedBeforePresent union TargetPresent
```

Both sets are therefore in the target NodeKey representation.

A key absent from both `GconvertedBefore` and `Gtarget` needs no semantic event solely because historical records exist. Its old history is still retained/re-encoded by the total codec.

## 15. Pass M1 — target values / absence

For each target-present K:

- occurrence-preserving decision -> require K in `ConvertedBeforePresent`, set `targetValueId(K) = valueId_GconvertedBefore(K)`, and author no ValueEvent;
- genuine create/replace -> author `ValueEvent(reason="migration")`, use its ID.

For each K in `ConvertedBeforePresent - TargetPresent`, author one required `DeleteEvent(reason="migration")` unless converted history already selects absence.

A non-identity representation rewrite `Ks -> Kt` therefore does not make `Ks` look deleted and `Kt` look newly created: only `Kt` participates in semantic-repair bookkeeping, and its preserved occurrence keeps the original ValueId.

Call replay after M1 `P1`.

## 16. Pass M2 — exact target proof

For each target-present K define:

```text
CurrentValid(K) = semantic incoming validity edges in P1
TargetValid(K)  = semantic incoming validity edges in Gtarget
```

### 16.1 Explicit node invalidation

If migration explicitly chose `invalidate(K)`, author:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "node" },
    reason: "migration"
}
```

This is semantic node invalidation, not a certificate-selection trick.

### 16.2 Maintenance-only proof weakening

Otherwise, for every removed edge while preserving K's occurrence:

```text
D in CurrentValid(K) - TargetValid(K)
```

author:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "proof", value: targetValueId(K), input: D },
    reason: "migration"
}
```

A `proof(V,D)` barrier retires only `D -> K` for exact occurrence V until causally re-proved. It does not invalidate unrelated certificate entries or another ValueId.

Concurrent barriers compose by removing the union of their named edges. Therefore independent migrations weakening the same preserved occurrence do not destroy unrelated proof.

A stale `keep` does not enter this path merely because it is stale. M2 authors barriers only for validity edges actually absent from `Gtarget`, such as edges removed by target schema/proof semantics.

If migration only adds validity, no barrier is required solely for the addition.

### 16.3 Target validation

After required invalidation/barriers, if replay does not already provide exact target validity/freshness coverage, author one:

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

Use `targetValueId(D)` exactly for `D in TargetValid(K)`, otherwise `"unknown"`.

One entry exists for every current direct input in canonical NodeKey order.

Call replay after M2 `P2`.

## 17. Pass M3 — persistent target freshness

For each present K let C be its replay-selected certificate and define:

```text
selfProofReady(K) iff
    C exists
    and effectiveBasisMatchCount(K,C) == numberOfDirectInputs(K)
    and coversValueInvalidations(K,C)
```

For target-fresh K, final replay must be fresh; causally later validation covers observed invalidations as needed.

For target-stale K:

- if an uncovered `value(targetValueId(K))` invalidation already applies, do not duplicate it;
- otherwise, if `selfProofReady(K)` is true, author:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "value", value: targetValueId(K) },
    reason: "migration"
}
```

This applies even when replay is already stale solely through an input. Recursive staleness alone is not a persistent stored stale flag; without the marker a later upstream `Unchanged` could incorrectly freshen K.

If `selfProofReady(K)` is false, K already has a persistent own proof/invalidation reason for staleness and an additional value marker is unnecessary solely to duplicate that reason.

## 18. Writer state

Migration preserves writer identity, writer sequences, authority coordinates, and foreign histories.

It never renumbers old Journal records.

If migration changes the local NodeIdentifier allocation watermark, record the resulting watermark with `WriterStateRecord`.

## 19. Migration postcondition

Before cutover require:

```text
target global/version == targetVersion
all retained Journal records use targetVersion canonical format
all old JournalRecordIds retain their historical identity
project(Jafter, targetSchema) == Gtarget
```

Equivalence includes persistent stale behavior: an upstream later `Unchanged` cannot erase a migration-propagated stored stale flag.

The inactive target becomes active atomically. Failure before cutover leaves the old source-version pair selected.

## 20. Synchronization across migration

Ordinary synchronization only occurs between exactly compatible current version/schema interpretations.

Replicas at different versions independently migrate first.

Shared pre-migration records rewritten through the same total codec compare identically after migration, including records for target-removed node families.

Migration-authored semantic records then synchronize normally. No peer must participate in the migration or later return for migration correctness.

## 21. Historical certificates after schema change

Old ValidateEvents remain intelligible because their input NodeKeys are self-describing.

Current replay uses such a certificate only when:

- it targets the selected current ValueId;
- its explicit input-key set equals the current input set; and
- ordinary invalidation/effective-proof selection accepts it.

Proof weakening uses `proof(V,D)` barriers for exact removed edges. True explicit invalidation keeps node scope.

## 22. Atomic publication

Migration is exclusive maintenance:

1. source remains active;
2. inactive target is built;
3. all retained history is rewritten into target format;
4. semantic repair records are appended;
5. target replay/projection/invariants are verified; and
6. one atomic cutover selects target.

Failure leaves the previous active pair selected.

## 23. Required tests

At minimum cover:

### Bootstrap

- canonical source exists / definitely absent / indeterminate decisions;
- first-creator arbitration and competing-artifact rejection;
- frozen original bootstrap cut, never later current history;
- artifact target mismatch -> `JournalVersionCompatibilityError` before history;
- semantic/time/allocator-dependent pre-bootstrap transformation is rejected;
- creator artifact durable before ordinary authoring;
- creator crash resumes exact artifact without rerunning callbacks;
- creator mismatch -> `JournalBootstrapForkError`;
- canonical and joining bootstrap ValueEvents use nondecreasing `(modifiedAt, canonical NodeKey)` writer order; an out-of-order joining stream is authority-inconsistent and rejected;
- exact canonical-equal occurrence reuses canonical ValueId;
- a local dependent whose legacy-valid input loses to another selected occurrence keeps the losing local input ValueId in its basis and is hard stale; bootstrap never manufactures validity against the winner;
- exact-shared validity intersection via `proof(V,D)` barriers;
- joining-only proof cannot strengthen shared occurrence;
- stale on either exact-shared side remains persistently stale;
- recursive-only bootstrap stale dependent receives `value(V)` marker;
- older/newer divergent legacy values resolve by persisted `modifiedAt`, not upgrade time;
- legacy absence does not fabricate delete;
- local-only and canonical-only materializations survive;
- joining writer keeps own fingerprint/watermark;
- accepted non-canonical ValueId split is exercised;
- a post-bootstrap validation unseen by a late join is concurrent with the join's negative proof/stale evidence and does not clear it until a causally later validation occurs.

### Journal-aware migration

- `keep` preserves ValueId, freshness, and current-shape-compatible incoming validity even when the node is recursively stale;
- stale `keep` alone authors no proof barriers;
- total pure format codec rewrites selected/non-selected/target-removed history identically across replicas;
- `rewriteNodeKey` applies to every embedded NodeKey, is injective over distinct retained source NodeKeys, and ValidationBasis is re-sorted by target canonical NodeKey order;
- `rewriteComputedValue` applies to every retained ValueEvent, including non-selected history;
- codec functions are synchronous, deterministic, and capability-free;
- non-total/throwing/colliding codec fails `JournalVersionCompatibilityError` before cutover;
- semantic repair compares `GconvertedBefore` and `Gtarget` in target NodeKey space;
- non-identity `Ks -> Kt` representation rewrite plus `keep` preserves the old ValueId without replacement ValueEvent or spurious DeleteEvent;
- representation-only change uses codec + `keep`;
- explicit `invalidate()` preserves ValueId and authors node invalidation;
- per-edge `proof(V,D)` barriers remove exactly target-retired validity;
- concurrent same-V barriers preserve unrelated proof and compose by edge union;
- proof/freshness/schema-only changes create no ValueEvent;
- migration-propagated stale dependent remains stale after upstream `Unchanged`;
- true create/replacement creates new ValueId;
- independent genuine replacements may later stale dependents;
- target replay exactly equals migration target;
- failure before cutover leaves source selected;
- replay never reruns historical migration callbacks.

## Non-goals

This specification does not define Git branch mechanics, hosted synchronization backend, SQL/HTTP APIs, deployment orchestration, or another transport protocol.
