# IncrementalGraph Journal 3 Local Storage Requirements

## Purpose

This document specifies local storage properties required by Journal 3 without choosing a remote/backend product, changing transport behavior, or prescribing exact LevelDB key names.

Existing IncrementalGraph sublevel formats remain unchanged during Journal 3 work; Journal-specific authoritative/derived state lives in new storage namespaces.

## Required logical state

A conforming local implementation persists enough information to recover:

- every retained Journal record by `JournalRecordId`;
- ordered per-writer ranges;
- retained frontier, explicitly or derivably;
- current local writer identity;
- existing durable compatibility metadata (`global/version`, `global/graph_scheme`);
- matching materialized graph projection;
- optional derived indexes/caches.

Journal records are authoritative semantic history. Index/frontier caches are rebuildable derived state.

## Existing graph sublevels remain projections

Do not embed Journal provenance/causal/synchronization metadata into existing `values`, `freshness`, `valid`, `timestamps`, or identifier record formats.

## One current format per active replica

The active replica's existing `global/version` selects complete persisted representation, including Journal records/derived metadata.

Journal records carry no independent format discriminator.

During database migration, source active and inactive target replicas may temporarily use different whole-database versions, but each replica individually remains homogeneous.

A target becomes active only after all retained records are rewritten into target canonical representation and semantic migration replay validates.

A `CanonicalBootstrapSnapshot` is lifecycle source state, not active JournalReplica. Its historical representation is interpreted only by software which explicitly supports that bootstrap target; Journal 3 does not require arbitrary future releases to retain old artifact compatibility forever.

## Ordered writer ranges

Storage supports logical iteration:

```text
records(author, afterExclusive, throughInclusive)
```

in ascending sequence order without scanning unrelated writers.

## Canonical current record codec

For one database version each Journal record has one canonical persisted representation/meaning.

The codec preserves record ID, event kind/body, causal context, authority time, references, payload/timestamps, reasons/scopes/certificate bases, and writer-state fields.

ValidateEvent basis encoding is self-describing:

```text
{ input: NodeKey, value: ValueId | "unknown" }
```

with unique input keys serialized by canonical persisted NodeKeyString order.

InvalidateEvent scope encoding distinguishes:

```text
{ kind: "node" }
{ kind: "value", value: ValueId }
{ kind: "proof", value: ValueId }
```

The three scopes have different replay meanings and must not be collapsed in storage.

## Causal-context validation support

Storage/import/open validation verifies semantic-event contexts are genuine closed cuts.

For F=(W,q):

```text
F.context[W] == q - 1
```

and every semantic event E included by F.context satisfies `E.context <= F.context` componentwise.

It is insufficient to validate only that coordinates are within retained frontier.

Controlled pre-Journal bootstrap conversion may intentionally leave canonical foreign coordinates out of a joining legacy ValueEvent's context so pre-existing legacy value remains concurrent with canonical value. Resulting context is still validated for own-prefix exactness and transitive closure over every coordinate it includes.

## Individual record sizing

Journal 3 imposes no compacted-journal total-size bound.

A ValueEvent may contain application-sized `ComputedValue`, so one record may scale with payload size.

Records remain individually addressable so range streaming/recovery does not require loading complete history.

## Atomic local publication

Local storage supports atomic publication of matching graph and finalized Journal records at supported observation boundary.

Ordinary operations may use one transaction/batch. Synchronization/reset/bootstrap/migration may build inactive target state and atomically cut over.

## Immutable historical identity within one format

Outside explicit database-format migration, a committed `(author,sequence)` body/meaning is never mutated.

A version migration may rewrite every retained record representation only when it deterministically preserves record identity, historical semantic meaning, causal/reference relationships, and writer coordinate.

Representation rewrite itself is not semantic Journal event.

## Pure payload representation rewrite

When database-version migration changes `ComputedValue` representation, one pure per-record codec determines target payload representation of every affected retained `ValueEvent`.

Codec result depends only on source record and version-migration definition, not selection, callback order, or replica-local mutable state.

Therefore two replicas retaining same historical `JournalRecordId` rewrite that record identically even when only one currently selects it.

## Semantic-preserving `override()` storage rewrite

For Journal-aware migration, `MigrationStorage.override()` is semantic-preserving assertion, not direct mutation of immutable retained record bytes.

For selected overridden occurrence verify:

```text
overrideResult == canonicalRewrittenPayload(selectedValueEvent)
```

while preserving ValueId, NodeIdentifier, timestamps, causal context/authority meaning, and references.

Mismatch fails migration before cutover.

## Maintenance proof/freshness records

Local Journal storage must support maintenance authoring patterns required to reproduce existing graph flags exactly.

### Proof weakening barrier

When reset/migration preserves ValueId V but target validity removes a currently-valid incoming edge for that occurrence, maintenance writes:

```text
InvalidateEvent {
    node: K,
    scope: { kind: "proof", value: V },
    reason: "reset" | "migration"
}
```

before the target validation.

This barrier is semantic history, not derived metadata. Older stronger certificates targeting V remain retained but become ineligible because they did not observe the barrier. Certificates for another occurrence V2 are not affected merely because they belong to the same node.

A real explicit `invalidate(K)` remains node-scoped. Storage must preserve the distinction between direct node invalidation and maintenance-only proof weakening.

### Persistent stale marker

When reset/migration target stores K stale while K's own selected proof is otherwise complete, storage retains an uncovered value-scoped invalidation for final K ValueId even if K is already recursively stale through an input.

Bootstrap join has the same persistence obligation after merging legacy evidence: if a selected occurrence has complete own proof but is stale through a direct input, an uncovered `reason="bootstrap"` value-scoped marker is retained/authored so a later upstream `Unchanged` cannot erase the stored stale transition.

## Semantic migration identity

Migration preserves existing ValueIds for occurrences retained by `keep`, `override`, `invalidate`, schema/proof/freshness-only changes, and equivalent occurrence-preserving transitions.

When migration genuinely creates/replaces occurrence, local migrating writer may author new ValueEvent. Different replicas may independently create different replacement ValueIds; later synchronization resolves normally and may stale dependents naming losing replacement.

Storage does not require canonical remote migration author.

## Canonical pre-Journal bootstrap artifact

The first supported pre-Journal -> Journal transition is a semantic-identity Journalization of an already-persisted legacy graph. It does not first run ordinary legacy semantic migration callbacks.

The bootstrap target therefore preserves the persisted source's graph interpretation and exact materialized semantic state, including NodeIdentifiers, payloads, timestamps, freshness, validity, and allocator watermark. A source/target pair which would require wall-clock/allocator-dependent `create()` or another semantic migration before Journalization is not an automatic bootstrap path and fails compatibility before bootstrap history is authored.

One canonical semantic bootstrap cut supplies shared ValueId basis for occurrences equal to canonical cut.

Configured cohort bootstrap source may return immutable `CanonicalBootstrapSnapshot` containing:

- exact bootstrap target `databaseVersion`;
- exact bootstrap target `graphSchemeString`;
- canonical creator writer identity;
- exact `bootstrapFrontier` captured immediately after bootstrap publication;
- exactly records through that frontier, with no post-bootstrap records.

The artifact is immutable while a running software release claims support for that bootstrap target. If a later release no longer supports target version/schema, bootstrap join fails compatibility rather than requiring permanent old-format support.

A current `JournalSnapshot` containing canonical records as prefix is not equivalent artifact.

Artifact storage/transport mechanism is unspecified.

### Creator resume storage

If artifact publication succeeded but creator local cutover failed, a restart with matching `creatorWriter` compares the artifact projection directly with the still-persisted legacy graph under the semantic-identity bootstrap interpretation. It does not rerun a migration callback or regenerate timestamps/identifiers.

On equality it installs **exactly** artifact records as local stream and reconstructs writer head, `last_node_index`, authority high-water, projection, and indexes. No duplicate bootstrap records are allocated.

Semantic mismatch is `JournalBootstrapForkError` and changes no active state.

### Ordinary joining storage

A joining host retains canonical cut verbatim and may additionally persist:

- historical joining-writer bootstrap ValueEvents for local-only/different occurrences;
- bootstrap proof/freshness records derived from legacy evidence;
- local WriterStateRecord preserving allocator watermark.

Equal occurrences continue to reference canonical ValueIds. For an exact shared occurrence, canonical proof is not replaced by a causally-later joining validation merely to strengthen proof. If either canonical or joining copy is stale, the shared occurrence remains persistently stale and an uncovered value-scoped bootstrap marker is retained/authored when necessary.

After direct bootstrap stale evidence is represented, join propagates persistent staleness through the selected dependency DAG: a selected occurrence with complete own proof and a stale direct input receives/retains a value-scoped bootstrap marker unless one already applies.

Local absence does not create bootstrap DeleteEvent against canonical materialization.

Joining historical ValueEvents may omit canonical foreign coordinates so conflicts remain concurrent; authority is seeded from legacy `modifiedAt`.

Two independent joiners may assign distinct ValueIds to same non-canonical occurrence; this is accepted by `$id-1635227135166767` rather than solved in storage by payload-derived identity.

## No destructive replay-history GC

Base Journal 3 does not delete authoritative historical records merely because current effect can be summarized.

A version migration replacing source-format encodings with target-format encodings of same records is representation replacement, not semantic compaction.

## Derived indexes

Optional rebuildable indexes may include per-writer head/frontier, record-by-node history, selected current head, candidate certificate/invalidation indexes, reverse structural edges, authority high-water, context-closure summaries, and replay checkpoint references.

Derived data never becomes independent semantic authority.

## Stable local snapshots

When local storage supplies `JournalSyncSource`, it provides one stable snapshot containing from same committed state:

- exact `databaseVersion`;
- exact `graphSchemeString`;
- `localWriter`;
- fixed frontier;
- corresponding immutable records.

Ordinary `JournalSnapshot` represents current state. It is distinct from canonical bootstrap artifact.

Journal 3 does not specify how external transport supplies either abstraction.

## Startup validation

Before retained history is relied on as supported semantic evidence, implementation enforces current-format decoding, writer contiguity, exact own-prefix event contexts, transitive context closure, authority extension, ValueId reference causality, canonical certificate shape, and Journal/projection consistency or successful rebuild.

Malformed authoritative history is rejected rather than repaired from mutable graph bytes.
