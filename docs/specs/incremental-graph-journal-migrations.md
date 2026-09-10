# IncrementalGraph Journal 2 Migration

## Purpose

This specification defines migration from a pre-Journal-2 database representation to Journal 2 without changing any existing IncrementalGraph sublevel representation.

Migration adds only the new journal sublevel and advances the database version according to the normal exact-version lifecycle.

The migration implementation has one stable bounded `MigrationId` supplied by the database migration/lifecycle registry. If this migration persists a high-level `OperationRecord(kind="migration")`, that record MUST contain this `MigrationId`; the operation envelope must not collapse all migrations into an indistinguishable generic `migration` kind.

`ValueEvent(reason="migration")`, `ValidateEvent(reason="migration")`, `DeleteEvent(reason="migration")`, and `InvalidateEvent(reason="migration")` are reserved for Journal-2-aware migrations which create/rematerialize, revalidate, remove, or invalidate already represented semantic nodes under the general database migration lifecycle. The initial pre-Journal-2 bootstrap defined here uses the distinct `reason="bootstrap"` events because it begins with no prior Journal 2 semantic baseline.

This document fully specifies the initial pre-Journal-2-to-Journal-2 bootstrap. A later migration whose input already contains valid Journal 2 state must separately specify any migration-specific per-node transformation beyond the generic mapping below. Journal 2 nevertheless imposes migration-wide rules on every such later migration: receiver-local stored source cursors are not preserved across the migration, synchronization-relevant negative authority is not silently discarded, and every resulting legacy freshness/validity transition must have the corresponding Journal 2 event/summary representation.

## Preconditions

The source database must satisfy the current legacy IncrementalGraph invariants:

- materialized nodes are covered by the identifier lookup;
- `values`, `freshness`, and `timestamps` have the same materialized key set;
- the dependency graph is schema-valid and dependency-closed;
- fresh nodes have complete incoming validity;
- every `valid` edge is structurally sound.

Corrupt legacy state is rejected rather than assigned invented journal meaning.

Every legacy `createdAt` and `modifiedAt` retained by the bootstrap must be parseable by the canonical timestamp conversion required by Journal 2, and every materialized timestamp record must satisfy `createdAt <= modifiedAt`. Malformed persisted timestamps are rejected rather than assigned invented Journal metadata or authority.

## Journal-2-aware migration cursor invalidation

A migration whose input already contains Journal 2 MUST atomically delete every receiver-local stored source cursor, for example every record under:

```text
journal/cursors/*
```

The deletion is required even when the migration does not obviously change a particular source's nodes.

A source cursor certifies more than a source sequence coordinate: it also relies on the receiver-local invariant that the current receiver state already incorporates that source's synchronization-relevant state through the cursor. A database/schema migration may change the graph schema, dependency interpretation, materialized state, certificates, invalidation meaning, or other Journal 2 state on which that invariant depended. Journal 2 therefore does not assume that the pre-migration cursor remains valid under the post-migration interpretation.

The base Journal 2 design intentionally provides no migration optimization for proving individual cursors safe to preserve. After a Journal-2-aware migration, the next synchronization with each source falls back to full synchronization. A successful full synchronization may then establish a fresh cursor under the migrated state.

This rule preserves the required equivalence between incremental synchronization and the normative full-sync result without requiring every migration to prove a cross-version cursor theorem.

The initial pre-Journal-2 bootstrap has no valid Journal 2 source cursors to preserve, so this rule adds no extra bootstrap work there.

## Journal-2-aware migration semantic preservation

A migration whose input already contains Journal 2 operates over more synchronization-relevant state than the ordinary legacy migration callback can enumerate. Define:

```text
migrationSemanticDomain =
    representedKeys(preMigrationJournal)
    union createdKeys(migration)
```

`representedKeys` includes both present/materialized summaries and retained absent/tombstoned summaries. `createdKeys(migration)` is the set of semantic NodeKeys newly materialized by `create` or by an explicitly specified migration-specific creation step. A key does not cease to be represented merely because it is absent from the legacy materialized-node migration scope.

The post-migration Journal 2 state MUST preserve every pre-migration synchronization-relevant fact unless the ordinary scope rules make that fact inapplicable after replacement, or a migration-specific rule explicitly proves equivalent future synchronization behavior. In particular:

- for every previously represented K, the post-migration `nodeInvalidateFrontier[K]` componentwise dominates the pre-migration `nodeInvalidateFrontier[K]`;
- if K is absent before migration and remains absent afterward, preserve its existing tombstone head unless the migration explicitly authors a later tombstone which supersedes that head; its node-scoped invalidation frontier remains componentwise preserved by the preceding rule;
- when `keep`, replica-stable `override`, or `invalidate` preserves K's current `ValueId`, preserve that value's existing `valueInvalidateFrontier` componentwise and join any migration-authored current-value invalidations into it;
- when a present K remains continuously materialized through migration, preserve its retained node-summary `createdAt` even if the migration authors a replacement `ValueId`; a newly materialized K created from absence sets a new `createdAt` from its new legacy timestamp record, and an absent result retains none;
- when migration creates a genuinely new `ValueId` for K, the old value-scoped frontier may be discarded because it is scoped only to the replaced value occurrence;
- a migration-created tombstone still retains the pre-migration node-scoped invalidation frontier for K, because that frontier is independent of the selected head/value occurrence.

An existing tombstoned K which is outside the ordinary materialized-node migration scope therefore remains represented automatically. Dropping such a tombstone merely because the legacy projection is already absent is forbidden: the tombstone may still be required to defeat an older value later presented by a delayed replica.

A Journal-2-aware migration also starts from the existing writer/header allocation state. It preserves `writer`, `journalIncarnation`, `localJournalCounter`, `localOperationCounter`, `causalSummary`, and `authorityClock` as the migration baseline and only advances those fields through ordinary migration-authored publications. It MUST NOT reinitialize writer-local counters or lower causal/authority high-water marks.

The resulting state must preserve J2-INV-7, J2-INV-8, J2-INV-9, and J2-INV-10. Migration may use a stronger migration-specific subsumption rule only when that migration explicitly proves that the replacement state preserves future synchronization behavior, including synchronization with delayed replicas.

Before cutover, every Journal-2-aware migration also establishes the exact derived reverse structural-edge index required by `incremental-graph-journal-api.md` for its resulting materialized graph. The index is rebuilt or transformed according to the new schema; pre-migration reverse-edge records are not synchronization authority and are not preserved when they disagree with the resulting graph.

## Journal-2-aware migration event mapping

A migration whose input already contains Journal 2 MUST publish Journal 2 state whose projection exactly matches the migration's resulting legacy value, freshness, validity, and creation-time state. The migration decision semantics in `migration.md` determine whether an invalidation is node-scoped or value-scoped; the `reason="migration"` tag records that the event was authored by migration and does not replace that scope distinction.

For semantic-value identity:

- `keep` preserves the current `ValueId` and head authority;
- `override` preserves the current `ValueId` and head authority **only** when it satisfies the replica-stability contract for identity-preserving override in `migration.md`;
- `invalidate` preserves the current cached value and therefore preserves its `ValueId` and head authority;
- `create` authors a new `ValueEvent(reason="migration")` for the created value occurrence;
- `delete` authors a `DeleteEvent(reason="migration")` whose tombstone becomes the final head.

Preserving a `ValueId` across migration is a cross-replica assertion, not merely a local optimization. If two supported replicas carry the same pre-migration `ValueId` V and independently apply the same identity-preserving migration into the same target version/schema, every supported result which still names V MUST carry the same exact migrated payload and `modifiedAt`. The node-summary `createdAt` is not part of V and may differ between replicas; ordinary Journal 2 synchronization joins it only among summaries carrying the same selected head, as specified by `incremental-graph-journal-sync.md`. Physical `NodeIdentifier` differences or host-local inputs must not make two copies of V diverge in payload or `modifiedAt` while retaining that identity.

A transformation which cannot satisfy that rule MUST NOT preserve V. If the migration itself installs a replacement value, it must author a new `ValueEvent(reason="migration")` and treat the result as a new semantic value occurrence, including the ordinary stale/invalidation effects on affected dependents. Otherwise the migration must invalidate or delete the old cache so later ordinary recomputation creates the replacement value occurrence. It is invalid to keep V while storing a replica-dependent replacement payload beneath it.

These operations apply inside `migrationSemanticDomain`; they do not authorize discarding synchronization-relevant summaries for represented keys which the ordinary materialized-node callback never visits.

A migration MAY retain an existing current-value certificate only when it is well-formed under the new schema and represents exactly the incoming validity edges retained by the migrated legacy state. Otherwise it authors a `ValidateEvent(reason="migration")` for the current ValueId with a basis that exactly represents those resulting incoming proofs. When migration must represent an absent incoming proof without a historical input ValueId against which that proof last held, the basis uses `"unknown"`.

Migration invalidation maps as follows:

- an explicit callback `invalidate(K)` authors a node-scoped `InvalidateEvent(reason="migration")` for K. It is ordered after any migration certificate whose incoming proof it invalidates. This removes K's incoming validity proofs while leaving its outgoing proofs intact, matching explicit migration invalidation;
- each automatic downstream invalidation propagated from that explicit decision authors a value-scoped `InvalidateEvent(reason="migration")` for the dependent's current ValueId. It marks that dependent stale without removing its retained validity proofs;
- a preexisting stale node carried through `keep` or replica-stable `override` is conservatively treated by `migration.md` as a direct invalidation root because persisted legacy state does not retain its staleness provenance. Its migrated Journal 2 state therefore contains a node-scoped `InvalidateEvent(reason="migration")` not covered by the final certificate, so its incoming proofs are absent;
- `create(..., "potentially-outdated")` authors its migration value/certificate baseline with no claimed incoming validity proofs and then a value-scoped `InvalidateEvent(reason="migration")` for the newly created ValueId. This keeps the new cache stale, including for zero-input nodes. `create(..., "up-to-date")` requires the ordinary complete current-input basis and no migration invalidation.

Migration-specific transformations may require additional `ValueEvent(reason="migration")`, `ValidateEvent(reason="migration")`, `InvalidateEvent(reason="migration")`, or `DeleteEvent(reason="migration")` events, but they MUST preserve these scope semantics and the graph/journal projection invariant. In particular, a migration MUST NOT use a value-scoped invalidation where the migration contract removes incoming proofs, or a node-scoped invalidation where the contract requires freshness-only propagation with proofs retained.

## Frozen existing sublevels

The migration must not rewrite a value merely to add Journal 2 metadata.

Except for ordinary lifecycle metadata whose value necessarily changes when the database version advances, all existing graph sublevel records retain their established representation and semantic contents.

In particular, no journal envelope is wrapped around `values`, `freshness`, `timestamps`, `valid`, or identifiers.

## Bootstrap writer state

Initialize:

```text
header.writer = existing DatabaseFingerprint
header.journalIncarnation = 1
header.localJournalCounter = 0
header.localOperationCounter = 0
header.causalSummary = {}
header.authorityClock = { physical: 0, logical: 0 }
```

When this bootstrap follows same-host restoration of a pre-Journal-2 snapshot, reuse of the existing `DatabaseFingerprint` is supported under the publication-before-propagation lifecycle invariant in `database-lifecycle.md`: no Journal 2 event from that writer can exist in supported external state unless this host's own authoritative published snapshot had first advanced to Journal 2.

This is a supported-state invariant, not a global discovery protocol. If the authoritative same-host snapshot is pre-Journal-2, migration MAY rely on the lifecycle invariant and MUST NOT scan, contact, or wait for every possible peer merely to prove the absence of unsupported same-writer Journal 2 events. If locally available evidence actually demonstrates that the invariant was bypassed—for example, a state being processed already contains incompatible same-writer Journal 2 evidence not represented by the authoritative snapshot—then the state is outside the supported lifecycle and bootstrap under that writer identity MUST be rejected. Journal 2 does not require detecting every unsupported external manipulation which is not locally observable.

Bootstrap semantic events use the canonical local semantic-event allocator from `incremental-graph-journal-types.md`, including its special initial-bootstrap value-authority rule. The initially empty causal summary contains no remote coordinates. Writer-local sequences and causal contexts still advance in normal bootstrap event order; only equal-`modifiedAt` bootstrap value occurrences are permitted to share an `AuthorityTime`.

If the initial bootstrap persists a high-level operation record, it uses `kind="migration"` and carries this migration's stable `MigrationId`. The semantic events it expands retain `reason="bootstrap"`; operation grouping is local history only and does not affect semantic allocation.

### Bootstrap pass ordering is strict

The four bootstrap passes below are one strict global sequence, not per-node phases which may be interleaved. The migration MUST complete Pass 1 for every materialized node before authoring any Pass 2 event, complete Pass 2 before Pass 3, and complete Pass 3 before Pass 4.

This ordering is required by the initial-bootstrap value-authority exception. Pass 1 value events may receive deterministic `AuthorityTime = { physical: canonical(modifiedAt), logical: 0 }`, while the later validate/invalidate events use the ordinary HLC allocator and may advance the authority clock to migration/publication wall time. If one of those later events were interleaved before an as-yet-unallocated bootstrap value, the following deterministic bootstrap authority could move backward relative to an earlier same-writer event and violate J2-INV-5. Completing all bootstrap value allocation first makes the exception safe.

## Pass 1: assign current value occurrences

Enumerate every materialized semantic NodeKey in ascending order of its legacy `modifiedAt`, with canonical NodeKey order as the deterministic tie-breaker. The ordering determines writer-local sequence allocation; it does not perturb the authority time of another value in the same equal-timestamp group.

For each K:

1. read K's unchanged legacy value/timestamp record;
2. author `ValueEvent(reason="bootstrap")` with
   ```text
   authorityTime = {
       physical: canonical(K.modifiedAt),
       logical: 0
   }
   ```
   as specified by the initial-bootstrap allocator;
3. assign its event ID as K's initial Journal 2 `ValueId`;
4. do not rewrite K's legacy payload or timestamps;
5. set the present semantic head to that ValueRef;
6. set `S[K].createdAt = canonical(K.createdAt)` in the new node summary.

Two independently migrating hosts which contain the same converged legacy value occurrence therefore assign the same `AuthorityTime` to that occurrence regardless of unrelated host-local nodes. When shared occurrences have equal `modifiedAt`, their bootstrap authority times tie across hosts, so the durable writer-fingerprint tie-break selects one writer consistently across the shared equal-time group rather than allowing unrelated local enumeration positions to create different per-node winners. Same-writer bootstrap events remain strictly ordered by writer-local sequence when their authority times tie.

The two hosts may nevertheless have different legacy `createdAt` values for that occurrence because creation time records when each current materialization lineage began. That does not change `ValueId` identity. If the same selected bootstrap head is later represented on both sides, synchronization takes the head-scoped minimum of those retained creation times.

This avoids making a derived shared node stale merely because its bootstrap certificate came from one host while an input with the same legacy timestamp was selected from another host solely due to host-local enumeration differences.

All current ValueIds are known before invalidation frontiers and certificate bases are constructed.

## Pass 2: preserve ambiguous stale provenance

Enumerate every legacy node whose freshness is `potentially-outdated` in canonical NodeKey order. For each such K, author one node-scoped `InvalidateEvent(reason="bootstrap")` after the bootstrap ValueEvents and before K's bootstrap certificate.

The pre-Journal-2 representation records that K is stale but does not retain whether that stale transition originated as an explicit/direct invalidation or only as downstream propagation. Bootstrap therefore conservatively records every legacy-stale K as a node-scoped invalidation root for future synchronization. This prevents the stale fact from disappearing merely because another independently bootstrapped replica represents the same legacy cached occurrence under a different bootstrap `ValueId`.

This conservative node invalidation does not remove any legacy incoming validity edge from the final bootstrap projection. The certificate authored for K in Pass 3 is causally after this invalidation and therefore covers it; the certificate basis then reconstructs the exact legacy `valid` relation. Pass 4 separately authors a later value-scoped invalidation so K remains stale without removing those reconstructed incoming proofs.

For a legacy fresh node, author no bootstrap node-scoped invalidation.

## Pass 3: encode incoming validity

Enumerate every materialized K in canonical NodeKey order. For each K, create one `ValidateEvent(reason="bootstrap")` using the migration/publication wall-clock time as its physical HLC seed.

Let `inputEdges(K) = [D0, D1, ...]`. Set:

```text
basis[i] = currentValueId(Di)
    if legacy valid[Di] contains K
basis[i] = "unknown"
    otherwise
```

This exactly represents the current legacy incoming validity relation without pretending to know historical input value identities which the old database never stored.

For a fresh node, the legacy invariant guarantees every basis entry is the current input ValueId.

For a stale node, partial validity is preserved exactly. Its bootstrap certificate covers the conservative node-scoped invalidation authored for that same node in Pass 2, so node invalidation does not itself remove any incoming edge represented by the basis.

The bootstrap certificate does not claim that an `"unknown"` basis entry was historically validated against the migration-time input. `"unknown"` records unavailable historical validity provenance only. It does not make the migrated cached value unsafe to retain or to supply later as `oldValue`: the existing IncrementalGraph algorithm permits a stale cached value to remain while dependencies change, and passes that cache to the computor when revalidation cannot prove reuse.

## Pass 4: encode stale state

Enumerate legacy nodes whose freshness is `potentially-outdated` in canonical NodeKey order. For each such node, author one value-scoped `InvalidateEvent(reason="bootstrap")` after its bootstrap certificate.

This is necessary even when the node currently has complete incoming validity: the existing flag algorithm deliberately keeps such a node stale until it is itself pulled/cache-revalidated. Together with Pass 2, the two bootstrap invalidations distinguish the future-relevant uncertainty about stale provenance from the current-value stale assertion required for exact local projection.

For a fresh node, author no bootstrap value-scoped invalidation.

Zero-input stale nodes are therefore also represented correctly.

After independently bootstrapped replicas synchronize, every node-scoped bootstrap frontier is joined regardless of which bootstrap `ValueId` wins head selection. A certificate from another bootstrap writer does not cover that frontier unless it actually observed the invalidation, so legacy stale knowledge cannot disappear solely because a different writer's equal-timestamp bootstrap value wins the deterministic head tie-break. A later genuine validation/cache-revalidation may cover the frontier normally.

## Pre-Journal-2 absence boundary

The initial bootstrap represents only materialized legacy NodeKeys. A pre-Journal-2 database has no finite synchronization-relevant absent-key domain and no persisted fact which distinguishes “this semantic key was deleted” from “this semantic key has never been materialized here.” The possible NodeKey universe may also be unbounded.

Therefore the initial bootstrap MUST NOT synthesize tombstones for arbitrary legacy-absent keys. Its absent-key term is `T = 0` unless the migration itself explicitly creates retained absence authority for a known semantic key.

Consequently, if independently migrated legacy hosts disagree only because K is materialized on A and absent on B, B contributes no pre-Journal-2 negative authority for K. Their first Journal 2 synchronization may legitimately materialize A's represented K on B. This is an intentional migration-boundary behavior, not resurrection of a Journal-2 deletion: no pre-Journal-2 tombstone for K ever existed to preserve.

Once Journal 2 is established, ordinary deletions/reset/migrations retain explicit tombstone authority according to the normal anti-resurrection rules; the absence limitation applies only to the initial legacy bootstrap boundary.

## Projection check

Before cutover, derive the Journal 2 projection and require exact agreement with the unchanged legacy graph for:

- materialized semantic node set;
- each materialized node's retained `createdAt` and selected occurrence `modifiedAt`;
- current `freshness` of every materialized node;
- every `valid` edge;
- dependency closure.

Payload records are not regenerated by projection and must remain the source records.

If the projection does not match, migration fails before publication.

For a migration whose input already contains Journal 2, projection agreement is necessary but not sufficient: the migration must also satisfy the synchronization-authority preservation rules above for every key in `migrationSemanticDomain`.

## Initial compaction

The bootstrap passes themselves publish the synchronization-relevant Journal 2 baseline directly: the final header, one node summary per materialized node, one current changed-node marker per represented node, and the derived reverse structural-edge index are already maintained by the same publication/cutover rules used elsewhere. An immediate canonical compaction therefore does not construct or rewrite those records; it may only remove the now-redundant bootstrap raw semantic events and high-level operation grouping.

After such immediate compaction, the retained journal contains:

- header, including the final local sequence, causal summary, and HLC authority high-water mark;
- one node summary per materialized node, including its retained `createdAt`;
- one changed-node marker per represented node;
- one reverse structural-edge record per materialized dependency edge;
- no required historical raw event/operation prefix.

The conceptual bootstrap history remains the explanation of how the Journal 2 baseline was established even if its raw semantic events and operation grouping are removed by compaction.

## Initial changed-node markers and structural index

Every represented node receives a current marker in the initial incarnation. There is no valid pre-Journal-2 cursor, so the exact bootstrap marker coordinates are used only for future Journal 2 cursors.

The initial bootstrap also constructs the exact reverse structural-edge index from the materialized legacy graph and current schema before cutover. Because the materialized graph is dependency-closed and direct in-degree is bounded, this requires O(L) individually bounded edge records.

## Synchronization compatibility

Journal 2 synchronization requires exact compatible database versions and valid Journal 2 metadata on both sides. A pre-Journal-2 replica is not incrementally or semantically synchronized directly with a Journal 2 replica and is not a valid Journal 2 reset source.

It must first migrate to Journal 2. Same-host restoration may restore an older pre-Journal-2 saved database as lifecycle recovery, but the migration gate must establish Journal 2 before that state participates in Journal 2 synchronization or semantic reset.

A later migration from one Journal-2-aware database version to another deletes receiver-local source cursors as specified above. Exact version compatibility still applies after migration; once compatible migrated peers synchronize again, their first post-migration synchronization relationship is re-established by full synchronization rather than by a pre-migration cursor.

## Size

Let L be the number of materialized nodes in the legacy state being migrated. The initial migration baseline has no historical Journal-2 tombstone domain, so its bootstrap work is O(L) semantic events plus at most O(1) high-level operation records and O(L) reverse structural-edge records under the bounded direct-in-degree assumption.

Each present node summary additionally retains one bounded `createdAt` scalar. This is `O(log H)` bits per present summary and does not change either the per-value or compacted asymptotic bound.

Each event/index record is individually within the Journal 2 per-value bound, and after canonical compaction O(L) bounded summaries/markers/reverse-edge records plus one bounded header remain.

Therefore the migrated compacted journal satisfies the general bound:

```text
O((L + T) R log H) bits
```

with `T = 0` at this initial bootstrap unless the supported migration explicitly creates retained absent-key authority, and with individual journal LevelDB values bounded by:

```text
O(R log H) bits.
```
