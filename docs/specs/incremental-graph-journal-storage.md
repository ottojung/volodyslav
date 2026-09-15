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

The active replica's existing `global/version` selects the complete persisted representation, including Journal records/derived metadata.

Journal records carry no independent format discriminator.

During database migration, source active and inactive target replicas may temporarily use different whole-database versions, but each replica individually remains homogeneous.

A target becomes active only after all retained records are rewritten into target canonical representation and semantic migration replay validates.

A frozen `CanonicalBootstrapSnapshot` is a lifecycle artifact, not an active JournalReplica. It may remain encoded at the original bootstrap target version after active replicas migrate forward; that does not create mixed formats inside an active database.

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

## Causal-context validation support

Storage/import/open validation verifies that semantic-event contexts are genuine closed cuts.

For F=(W,q):

```text
F.context[W] == q - 1
```

and every semantic event E included by F.context satisfies `E.context <= F.context` componentwise.

It is insufficient to validate only that coordinates are within retained frontier.

The controlled pre-Journal bootstrap conversion rule may intentionally leave canonical foreign coordinates out of a joining legacy ValueEvent's context so a pre-existing legacy value remains concurrent with the canonical value. The resulting context is still validated for own-prefix exactness and transitive closure over every coordinate it actually includes.

## Individual record sizing

Journal 3 imposes no compacted-journal total-size bound.

A ValueEvent may contain an application-sized `ComputedValue`, so one record may scale with payload size.

Records remain individually addressable so range streaming/recovery does not require rewriting/loading complete history.

## Atomic local publication

Local storage supports atomic publication of matching graph and finalized Journal records at the supported observation boundary.

Ordinary operations may use one transaction/batch. Synchronization/reset/bootstrap/migration may build inactive target state and atomically cut over.

## Immutable historical identity within one format

Outside explicit database-format migration, a committed `(author,sequence)` body/meaning is never mutated.

A version migration may rewrite every retained record representation only when it deterministically preserves record identity, historical semantic meaning, causal/reference relationships, and writer coordinate.

Representation rewrite itself is not a semantic Journal event.

## Pure payload representation rewrite

When a database-version migration changes `ComputedValue` representation, one pure per-record codec determines the target payload representation of every affected retained `ValueEvent`.

The codec result depends only on the source record and version-migration definition. It does not depend on whether the record is selected on the current replica, on callback traversal order, or on replica-local mutable state.

Therefore two replicas retaining the same historical `JournalRecordId` rewrite that record identically even when only one replica currently selects it.

## Semantic-preserving `override()` storage rewrite

`MigrationStorage.override()` is a semantic-preserving representation decision.

For Journal-aware migration it does not directly supply the bytes/body of an immutable retained ValueEvent. The whole-history per-record codec already determines that target representation.

For the selected overridden occurrence, the migration verifies:

```text
overrideResult == canonicalRewrittenPayload(selectedValueEvent)
```

while preserving:

- selected ValueId;
- NodeIdentifier;
- createdAt/modifiedAt;
- causal context and authority meaning;
- cross-record references.

Mismatch fails migration before cutover. A representation-changing override therefore does not append a replacement ValueEvent and cannot cause one historical ID to acquire replica-dependent bodies.

## Semantic migration identity

Database migration preserves existing ValueIds for semantic occurrences retained by `keep`, `override`, `invalidate`, schema/proof/freshness-only changes, and equivalent occurrence-preserving transitions.

When migration genuinely creates/replaces a semantic occurrence, the local migrating writer may author a new ValueEvent. Different replicas may independently create different replacement ValueIds; later synchronization resolves those histories normally and may stale dependents whose certificates name a losing replacement.

Storage does not require or encode a canonical remote migration author.

## Frozen canonical pre-Journal bootstrap artifact

For initial legacy->Journal transition, one canonical semantic bootstrap cut supplies the shared ValueId basis for a cohort.

The configured cohort bootstrap source must be able to return an immutable `CanonicalBootstrapSnapshot` containing:

- exact bootstrap target `databaseVersion`;
- exact bootstrap target `graphSchemeString`;
- canonical creator writer identity;
- exact `bootstrapFrontier` captured immediately after bootstrap publication;
- exactly the records through that frontier, with no post-bootstrap records.

The artifact remains stable/retrievable for late legacy installations even after ordinary cohort history grows or active replicas migrate to newer versions.

A current `JournalSnapshot` which merely contains the canonical records as a prefix is not equivalent to this artifact.

The artifact's storage/transport mechanism is deliberately unspecified. The requirement is semantic durability/availability of the immutable artifact through the configured cohort bootstrap source, not a new backend protocol.

A joining host retains the canonical cut verbatim and may additionally persist:

- historical joining-writer bootstrap ValueEvents for local-only/different legacy occurrences;
- bootstrap proof/freshness records derived from its legacy evidence;
- its local WriterStateRecord preserving allocator watermark.

Equal occurrences continue to reference canonical bootstrap ValueIds. A local absence does not create a bootstrap DeleteEvent against a canonical materialization merely to force equality with the joining legacy cache.

The joining historical ValueEvents may omit canonical foreign coordinates so conflicting legacy values remain concurrent; their authority is seeded from their own legacy `modifiedAt` as defined by the migration/type specifications.

## No destructive replay-history GC

Base Journal 3 does not delete authoritative historical records merely because their current effect can be summarized.

A version migration replacing source-format encodings with target-format encodings of the same records is representation replacement, not semantic compaction.

## Derived indexes

Optional rebuildable indexes may include per-writer head/frontier, record-by-node history, selected current head, candidate certificate/invalidation indexes, reverse structural edges, authority high-water, context-closure summaries, and replay checkpoint references.

Derived data never becomes independent semantic authority.

## Stable local snapshots

When local storage supplies a `JournalSyncSource`, it provides one stable snapshot containing from the same committed state:

- exact `databaseVersion`;
- exact `graphSchemeString`;
- `localWriter`;
- fixed frontier;
- corresponding immutable records.

An ordinary `JournalSnapshot` represents current state. It is distinct from the frozen canonical bootstrap artifact used by pre-Journal join.

Journal 3 does not specify how an external transport supplies either abstraction.

## Startup validation

Before retained history is relied on as supported semantic evidence the implementation enforces current-format decoding, writer contiguity, exact own-prefix event contexts, transitive context closure, authority extension, ValueId reference causality, canonical certificate shape, and Journal/projection consistency or successful rebuild.

Malformed authoritative history is rejected rather than repaired from mutable graph bytes.
