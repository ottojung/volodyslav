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

## 4. Canonical bootstrap source decision and publication arbitration

The configured transport-neutral `CohortBootstrapSource` supports both observation and atomic first-creator publication:

```text
queryCanonicalBootstrap() ->
    Exists(CanonicalBootstrapSnapshot)
  | DefinitelyAbsent
  | IndeterminateOrError

publishCanonicalBootstrapIfAbsent(candidate) ->
    Published(CanonicalBootstrapSnapshot)
  | AlreadyExists(CanonicalBootstrapSnapshot)
  | IndeterminateOrError
```

This conditional publication is the arbitration required by `$id-1847369205416728`. The query is not the arbitration point.

Query semantics:

1. **Exists** — hold the immutable artifact and use creator-resume or ordinary join according to writer identity;
2. **DefinitelyAbsent** — the installation may construct/stage a deterministic candidate, but MUST still call `publishCanonicalBootstrapIfAbsent`;
3. **IndeterminateOrError** — fail and MUST NOT create competing canonical history.

Publication semantics:

1. **Published(B)** — B is now the one durable canonical artifact for the cohort. The caller may perform local creator cutover only after validating that B is the published form of its staged candidate.
2. **AlreadyExists(B)** — another publication already won, or an earlier attempt by this same creator succeeded and its response was lost. Discard the losing staged candidate. If `B.creatorWriter == local DatabaseFingerprint`, enter creator-resume; otherwise perform ordinary join.
3. **IndeterminateOrError** — the publication outcome is unknown or failed. Do not cut over locally and do not publish another distinct artifact. Keep the supported pre-Journal database active and resolve the outcome by re-querying before retrying.

Semantically, for one cohort canonical slot, concurrent distinct candidates cannot both obtain `Published`. Any transport mechanism is acceptable if it implements that conditional-publication property.

Distinct canonical artifacts discovered despite this contract are unsupported bootstrap forks requiring explicit recovery; they are not payload-merged.

No particular peer must reconcile, acknowledge, or return merely for bootstrap to finish, consistent with `$id-4719065396881648`.

## 5. Canonical creator records

The canonical creator uses its existing durable `DatabaseFingerprint` as `JournalAuthor` and starts its Journal at frontier zero.

### 5.1 Deterministic canonical authority

The canonical candidate uses the deterministic authority rules in `incremental-graph-journal-types.md` §Pre-Journal bootstrap ValueEvent authority exception / §Canonical creator post-value authority. It does not consult upgrade/publication wall clock.

Each C1 bootstrap ValueEvent converts one existing legacy occurrence and uses historical legacy authority:

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

For every materialized K in canonical persisted NodeKey order author one self-describing:

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

For every legacy-stale K in canonical persisted NodeKey order author, after its certificate:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "value", value: bootstrapValueId(K) },
    reason: "bootstrap"
}
```

### 5.5 Pass C4 — writer state and conditional publication

Record the creator's legacy `last_node_index` using `WriterStateRecord`.

Freeze the resulting staged candidate at `bootstrapFrontier`. Staging does not make it canonical and does not authorize local cutover.

Call:

```text
publishCanonicalBootstrapIfAbsent(candidate)
```

and handle the result exactly as §4 requires:

- `Published(B)`: validate B is the published candidate, then and only then install/cut over locally and enable ordinary post-bootstrap authoring;
- `AlreadyExists(B)`: discard the staged candidate and use creator-resume or ordinary join according to B's creator writer;
- `IndeterminateOrError`: leave the supported pre-Journal database active and make no local cutover.

Thus no query result alone can make a candidate canonical, and no local creator becomes Journal-active before conditional publication has selected the durable cohort artifact.

## 6. Creator resume and unknown publication outcome

A crash may occur after conditional publication succeeds but before the creator receives the result or cuts over its local active database. It may therefore restart with supported pre-Journal state plus a staged candidate while the publication outcome is unknown.

On retry/restart, first re-query the canonical source:

- `Exists(B)` with `B.creatorWriter == local DatabaseFingerprint` -> validate B and use creator-resume;
- `Exists(B)` with another creator -> discard any staged local candidate and ordinary-join B;
- `DefinitelyAbsent` -> if a deterministic staged/reconstructed candidate is available, retry **that same** conditional publication; do not invent a second distinct candidate;
- `IndeterminateOrError` -> fail without cutover.

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

Use `selfProofReady(K)` as defined in `incremental-graph-journal-replay.md` §Persistent propagated staleness, evaluated at this pass's replay cut.

If `selfProofReady(K)` and some direct input is stale, ensure an uncovered:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "value", value: valueId(K) },
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

First rewrite **all retained history** into the target representation using the directed source->target `JournalFormatCodec` defined in §9a:

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

## 9a. Journal format codec contract

Journal-aware representation change has exactly one representation-rewrite mechanism: a pure directed source->target `JournalFormatCodec`. The ordinary pre-Journal `MigrationStorage` API in `migration.md` describes shipped behavior and is not the owner of this Journal 3 codec.

```text
JournalFormatCodec {
    rewriteNodeKey(sourceKey: NodeKey) -> NodeKey
    rewriteComputedValue(
        sourceKey: NodeKey,
        payload: ComputedValue
    ) -> ComputedValue
}
```

If a function is omitted, it defaults to the identity transform.

Both functions are synchronous and deterministic. They receive only their explicit arguments plus the fixed source->target migration definition; they receive no database handle, network/filesystem capability, clock, randomness, allocator, migration traversal state, or other mutable replica-local capability.

`rewriteNodeKey` changes representation only: its result denotes the same historical semantic node under the target version. It is injective over the complete supported source NodeKey semantic domain, independent of which keys one replica happens to retain.

Define `SourceNodeKeyDomain(sourceVersion)` as every distinct valid canonical semantic NodeKey which may occur in supported source-version Journal history, including keys for historical node families no longer present in the target schema. For every `K1`, `K2` in that domain:

```text
K1 != K2
    => rewriteNodeKey(K1) != rewriteNodeKey(K2)
```

This is a contract of the codec definition, not a property established solely by scanning one replica's retained history. A concrete migration rejects any collision it observes as defensive validation, but absence of a local collision does not prove the distributed injectivity requirement. A many-to-one node merge is semantic migration, not representation rewrite.

`rewriteComputedValue` likewise changes representation only and preserves the historical semantic value represented by the source ValueEvent. Semantic creation, replacement, or merging belongs to semantic migration decisions rather than the format codec.

The whole-history rewrite pipeline:

1. decodes each retained record under the source database version into the Journal semantic model;
2. rewrites every embedded NodeKey using `rewriteNodeKey`, including record node keys, `ValidationBasis.input`, and `proof(V,D)` input keys;
3. rewrites every retained ValueEvent payload using `rewriteComputedValue(sourceKey,payload)`, including non-selected values and values for node families absent from the target schema;
4. preserves `JournalRecordId`, writer sequence, contexts, AuthorityTime meaning, ValueId/reference identity, NodeIdentifier, and timestamps;
5. re-canonicalizes target-format structures after rewriting, including sorting every ValidationBasis by the target version's canonical persisted NodeKeyString order; and
6. encodes the transformed semantic record using the target version's canonical record encoding.

The codec is total over all retained source-version history. If any retained record has no deterministic valid target representation, or a locally observed NodeKey collision witnesses violation of the codec contract, migration fails `JournalVersionCompatibilityError` before cutover.

Two replicas applying the same canonical source->target transition to the same historical record must produce the same target-format record body.

Representation-only selected state uses semantic `keep`; there is no second value-producing migration decision for representation rewriting. A stale kept occurrence does not lose source-replay proof merely because it is stale: Journal provenance distinguishes explicit node invalidation, value-scoped stale state, proof-edge barriers, and recursive staleness. Target-shape changes are handled explicitly by semantic repair.

## 9b. Canonical Journal migration chain

Per-edge codec determinism is not enough when a replica can reach the same target version through different version paths. Immutable retained records keep their `JournalRecordId`, so every supported upgrade from one Journal version to another MUST have one canonical transition sequence.

For every supported non-current Journal version `v`, the release lineage defines at most one:

```text
canonicalNextJournalVersion(v)
```

A supported migration from stored version `v0` to running version `vn` follows exactly:

```text
v0 -> v1 -> ... -> vn
where vi+1 = canonicalNextJournalVersion(vi)
```

until `vn` is reached. If the complete chain is not available, that source version is unsupported and startup fails `JournalVersionCompatibilityError`.

A machine may skip application releases, but it does **not** skip canonical Journal migration transitions. Thus if one replica historically migrated `v1 -> v2 -> v3`, another replica later upgrading from v1 to v3 must execute the same semantic chain `v1 -> v2 -> v3`; it must not substitute an independently defined direct `v1 -> v3` migration.

Once a canonical successor edge has been used for supported Journal history, later releases which still claim support for that source version preserve **both the edge and its migration semantics**. The source/target version pair identifies a frozen canonical migration definition: its format codec, target semantic migration behavior, and any deterministic repair rules needed to reproduce that transition may not be silently changed by a later release.

Therefore a release that still supports v1 through an old canonical edge v1 -> v2 must carry the canonical v1 -> v2 definition needed to reproduce what earlier replicas executed. If that definition is no longer available, v1 is no longer a supported source version. Removing an old source version from support is allowed; redefining its path or edge semantics while retaining support is not.

Each chain step is a complete Journal-aware migration: whole-history codec rewrite, semantic repair, replay validation, and version cut to that intermediate version. Migration-authored records from an intermediate step are retained and are themselves rewritten by later canonical steps.

Consequently, if replicas X and Y share historical record R at v1 and both later reach v3 through supported migration, their v3 body for R is byte-identical even if X upgraded while v2 was current and Y skipped directly from the v1 application release to the v3 application release.

## 10. One-format / total-codec invariant

An active source replica is entirely source-format. The inactive target replica is entirely target-format. Journal records carry no per-record format selector.

For every retained source record R with ID `(A,q)`, the source->target migration defines exactly one deterministic target-format record with the **same ID and historical meaning**.

The normative codec contract and rewrite pipeline are in §9a. In summary, the rewrite:

1. decodes under the source version;
2. applies deterministic `rewriteNodeKey` to every embedded NodeKey;
3. requires `rewriteNodeKey` to be injective over the complete supported source-version NodeKey semantic domain, independent of which keys this replica retains, so two historical semantic nodes cannot collapse onto one target key after independent migrations;
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
replace
delete
create
```

### Callback key space

The Journal-aware migration callback is evaluated over a fixed source->target codec. Its addressing/checking rules are:

- `get(nodeIdentifier)` and traversal methods address previous-version materialized nodes by their source `NodeIdentifier` and expose source-representation data;
- every existing-node decision first resolves the source NodeKey `Ks` for that identifier and defines its semantic target key as `Kt = rewriteNodeKey(Ks)`;
- `keep(nodeIdentifier)`, `invalidate(nodeIdentifier)`, and `replace(nodeIdentifier,value)` perform target-schema functor/arity compatibility against **Kt**, not Ks; `delete(nodeIdentifier)` likewise deletes the transported target node Kt rather than a source-spelling node Ks;
- `create(nodeKeyString,...)` accepts a **target-representation** NodeKeyString. Before accepting creation, compare it against `rewriteNodeKey(Ks)` for every materialized source node `Ks` in the previous-version materialized set S. Equality means the target semantic node already exists through transported source state and MUST throw `CreateExistingNodeError`; it is not a new target node. The implementation-facing error guidance points existing-node value changes to `replace(nodeIdentifier,value)`, not to the removed legacy `override` path.

Therefore a representation-only rename `Ks -> Kt` can use `keep(id(Ks))` even when Ks itself is absent from the target schema, provided Kt is target-compatible. Conversely, `create(Kt)` cannot manufacture a second occurrence merely because the source lookup table spells the existing node as Ks.

These rules are Journal 3 target behavior. They do not redefine the currently shipped pre-Journal `MigrationStorage` implementation documented in `migration.md`.

### `keep`

Preserves the selected semantic occurrence and therefore its ValueId, timestamps, freshness, and every source-replay incoming validity edge whose certificate remains current-shape-compatible under the target input set.

A stale kept occurrence does **not** lose proof merely because it is stale. Journal history already distinguishes node invalidation, value-scoped stale state, proof-edge barriers, and recursive staleness. If target schema removes/changes an input edge, the resulting shape/proof difference is handled explicitly by M2 rather than by a generic stale-node heuristic.

Representation-only changes for that occurrence come from the canonical whole-history codec.

### `invalidate`

Preserves cached occurrence/ValueId, marks the node stale, and removes its incoming proof according to the migration framework.

Because this is genuine explicit node invalidation, for source identifier `id(Ks)` let `Kt = rewriteNodeKey(Ks)` and author:

```text
Invalidate(Kt, scope=node, reason="migration")
```

### `replace`

```text
replace(nodeIdentifier, value)
```

is the explicit decision for a genuine semantic value replacement of an already-materialized source node.

Resolve the source node `Ks` from `nodeIdentifier`, then `Kt = rewriteNodeKey(Ks)`, and validate Kt against the target schema. The replacement:

- preserves the existing materialization `NodeIdentifier`;
- preserves the existing `createdAt`;
- uses the supplied target-version `ComputedValue` as the new payload;
- sets `modifiedAt` to the migration publication/finalization physical time;
- authors a new `ValueEvent(reason="migration")` at Kt and therefore a new ValueId.

The new occurrence then participates in M2/M3 exactly like any other target-present occurrence. Historical certificates for the old ValueId do not certify the replacement. Target proof/freshness is established by M2/M3, and dependents whose target proof names an input occurrence are repaired against the replacement ValueId through the ordinary target-repair rules.

`replace` is semantic occurrence replacement, not representation rewrite. Pure representation changes remain codec + `keep`.

### `delete`

For source identifier `id(Ks)`, deletion applies to transported semantic target key `Kt = rewriteNodeKey(Ks)`. If converted history still selects a value at Kt, establish absence using:

```text
DeleteEvent(reason="migration")
```

### `create`

`create(nodeKeyString,...)` creates a genuinely new materialization which did not exist in the transported previous-version materialized set.

Both `create` and `replace` author a new:

```text
ValueEvent(reason="migration")
```

and therefore a new ValueId. `create` allocates the new materialization identity according to the migration allocator rules; `replace` preserves the existing materialization identity as specified above.

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
eligibleEffectiveProofUnion_P1(K) =
    eligibleEffectiveProofUnion(K) evaluated at replay cut P1

TargetValid(K) =
    semantic incoming validity edges in Gtarget
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

Otherwise, for every incoming edge that any eligible retained certificate for the preserved occurrence can currently prove but the migration target must not expose:

```text
D in eligibleEffectiveProofUnion_P1(K) - TargetValid(K)
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

Compute the barrier set from the fixed P1 cut before authoring M2 barriers. Since `eligibleEffectiveProofUnion_P1(K)` is the union of effective proof edges over **all** P1-eligible certificates for the preserved ValueId, every already-retained certificate is prevented from exposing a non-target edge after certificate selection changes. Proof barriers do not make an ineligible certificate eligible. A later migration-authored target certificate is causally after the barriers and may re-prove only target edges. Thus one barrier pass over `eligibleEffectiveProofUnion_P1(K) - TargetValid(K)` is complete.

This union is negative-maintenance analysis only; migration still never combines positive proof from different certificates.

A stale `keep` does not enter this path merely because it is stale. M2 authors barriers only for edges absent from `Gtarget` that some eligible retained certificate could otherwise expose.

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

Use `selfProofReady(K)` as defined in `incremental-graph-journal-replay.md` §Persistent propagated staleness, evaluated at this pass's replay cut.

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

Proof weakening uses `proof(V,D)` barriers for every non-target edge in the eligible-certificate effective-proof union. True explicit invalidation keeps node scope.

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

Required regressions for bootstrap and Journal-aware migration are owned by `incremental-graph-journal-testing.md`.

## Non-goals

This specification does not define Git branch mechanics, hosted synchronization backend, SQL/HTTP APIs, deployment orchestration, or another transport protocol.
