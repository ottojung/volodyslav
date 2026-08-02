# IncrementalGraph Journal Types

## Purpose

This document defines the core types used by the IncrementalGraph journal: journal entries, timestamps, host identifiers, journal indices, and the public `PossibleNodeChange` and `BaselinePossibleNodeChange` tokens.

All journal types follow the existing nominal/opaque typing discipline used by `NodeIdentifier`, `NodeKeyString`, `NodeName`, and related IncrementalGraph types. See `backend/src/generators/incremental_graph/database/types.js` and `docs/specs/keys-design.md` for the established patterns.

---

## JournalEventId (internal)

### Purpose

`JournalEventId` provides stable, immutable identity for one logical journal event. Logical journal events may be emitted by ordinary graph operations, migration (as ordinary host events), or synchronization (sync-derived `invalidate` and `delete` events).

There are exactly two event-ID variants, chosen so the formats are structurally
unambiguous: the ordinary host event and the sync-derived event.

```js
/**
 * Stable identity of one logical journal event.
 *
 * @typedef {string} JournalEventId
 */
```

#### Ordinary host event

An ordinary event originated by one host is identified by:

```js
const eventId = JSON.stringify([
    "host",
    hostnameToString(creator),
    hostEventNamespaceIdToString(namespaceId),
    journalIndexToNumber(originIndex),
]);
```

`namespaceId` is the host event namespace active when the event's original
index was allocated. The namespace scopes host event identity so that two
journal lineages installed on the same host cannot reuse an `originIndex`
under the same event ID.

Use exactly this tagged fixed-order tuple passed to `JSON.stringify`. No other
host-event format, version tag, custom serialization format, or optional
event-ID fields.

### Host event namespace (nominal)

`HostEventNamespaceId` is an opaque nominal identifier for one host event
namespace.

- A fresh namespace is generated when a host journal is initialized and after
  a successful `reset-to-hostname` (see `Journal lineage`).
- Existing events preserve their original namespace.
- Normal pairwise synchronization and migration preserve the current local
  namespace.
- Because host event identity is `["host", hostname, hostEventNamespaceId,
  originIndex]`, the lineage is present in the event ID; two lineages installed
  on the same host cannot collide even when the new lineage reuses numeric
  indices.

```js
/**
 * The properties that this type carries are:
 * - The value identifies one host event namespace, fresh on host journal
 *   initialization and on successful reset-to-hostname, and otherwise
 *   preserved.
 *
 * The proof of those properties is guaranteed by:
 * - This typedef cannot enforce the property by construction.
 * - Therefore every function that returns this type is part of the proof.
 * - The current return sites are:
 *   - host journal initialization, which allocates a fresh namespace;
 *   - successful reset-to-hostname, which allocates a fresh namespace for the
 *     newly installed lineage.
 */
class HostEventNamespaceIdClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("HostEventNamespaceId cannot be instantiated"); }
}

/** @typedef {HostEventNamespaceIdClass} HostEventNamespaceId */
```

Conversion functions:

```js
/**
 * Unsafe cast: wraps a string as a HostEventNamespaceId.
 * The function is defined only for a namespace identifier generated as
 * described above.
 *
 * @param {string} value
 * @returns {HostEventNamespaceId}
 */
function unsafeStringToHostEventNamespaceId(value)

/**
 * Render a HostEventNamespaceId to its string persisted representation.
 *
 * @param {HostEventNamespaceId} namespaceId
 * @returns {string}
 */
function hostEventNamespaceIdToString(namespaceId)
```

#### Sync-derived event

A sync-derived event must be identified from the exact unordered source
snapshots and the semantic event identity, so that either side of a pairwise
merge derives the same event ID. Each source snapshot carries a
`SourceSnapshotProvenance` whose `id` is a `SourceSnapshotId` (see
`Source snapshot provenance`).

The sync event ID is:

```js
const eventId = JSON.stringify([
    "sync-v2",
    graphAndJournalMergeProtocolVersion,
    lowerSourceSnapshotId,
    upperSourceSnapshotId,
    action,
    nodeKeyToString(key),
]);
```

`lowerSourceSnapshotId` and `upperSourceSnapshotId` are the two
source-snapshot-ID strings sorted by `canonicalPair` (deterministic JavaScript
code-unit ordering). The event ID includes
`graphAndJournalMergeProtocolVersion` so that two different merge protocols
producing different sync events for the same snapshots and action receive
different event IDs. The identity applies only to `SyncDeleteJournalEntry` and
`SyncInvalidateJournalEntry`.

Consequences:

- reversing the two source snapshots produces the same event ID;
- independently reconciling the same two exact snapshots under the same merge
  protocol produces the same event ID;
- a different merge protocol, a different derived source snapshot, or a
  different hostname producing the snapshot produces a different event ID;
- repeated placement of the same sync event is deduplicated by `eventId`;
- one `eventId` still identifies exactly one immutable payload;
- if the same sync event ID is encountered with different payloads,
  synchronization fails as a journal-integrity error.

A sync event ID must not depend on:

- the host executing reconciliation;
- local versus remote naming;
- local wall-clock execution time;
- the new physical journal index assigned during placement.

### SourceRevisionId (nominal)

`SourceRevisionId` is the nominal type for the leaf revision identifier of a
checkpoint staged directly from a host revision. It is not by itself the
identity of every possible merge input: derived pairwise merge results are
identified by a `SourceSnapshotId` (see `Source snapshot provenance`).

```js
/**
 * The properties that this type carries are:
 * - The value identifies the exact leaf revision/checkpoint from which a
 *   checkpoint source snapshot was staged.
 *
 * The proof of those properties is guaranteed by:
 * - This typedef cannot enforce the property by construction.
 * - Therefore every function that returns this type is part of the proof.
 * - The current return site is:
 *   - the synchronization staging layer: satisfies the property because it
 *     derives the revision identifier from the exact staged checkpoint/revision
 *     of a source snapshot and refuses to stage otherwise.
 */
class SourceRevisionIdClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("SourceRevisionId cannot be instantiated"); }
}

/** @typedef {SourceRevisionIdClass} SourceRevisionId */
```

Conversion functions:

```js
/**
 * Unsafe cast: wraps a string as a SourceRevisionId.
 * The function is defined only for the exact leaf revision identifier derived
 * from a staged checkpoint/revision.
 *
 * @param {string} value
 * @returns {SourceRevisionId}
 */
function unsafeStringToSourceRevisionId(value)

/**
 * Render a SourceRevisionId to its string persisted representation.
 *
 * @param {SourceRevisionId} revision
 * @returns {string}
 */
function sourceRevisionIdToString(revision)
```

### Semantics (shared)

- An event's immutable payload is fixed at its first durable commit.
- Copying an event preserves its event ID.
- Reappending an event preserves its event ID.
- Moving an event does not change its encoded `originIndex` or its host event
  namespace.
- Two ordinary events created by the same host within the same host event
  namespace cannot have the same origin index.
- Hostnames are unique within the synchronization mesh.

### Integrity

One event ID identifies exactly one immutable journal payload.

For identity comparison or integrity checking, use a fixed-order array and `JSON.stringify`:

```js
JSON.stringify([
    entry.action,
    nodeIdentifierToString(entry.id),
    nodeKeyToString(entry.key),
    unixTimestampToNumber(entry.time),
    journalCreatorToString(entry.creator),
    entry.eventId,
])
```

If the same `eventId` is encountered with different serialized payloads:
- fail synchronization;
- commit nothing;
- leave the active replica unchanged;
- do not poison the entries;
- do not choose one arbitrarily.

### Duplicate event positions

If the same `eventId` survives at several physical positions in the merged destination:
- retain the occurrence with the greatest `JournalIndex`;
- make all lower occurrences absent;
- do not create another fresh copy.

An unpositioned event queued for fresh placement does not participate in the "greatest position" comparison.

If the same event already survives at a positioned target entry, remove its queued fresh copy.

---

## Source snapshot provenance

### SourceSnapshotId (nominal)

`SourceSnapshotId` identifies the exact synchronization-relevant graph and
journal state of one source snapshot, including derived pairwise merge
results. The actual journal entries and their immutable event IDs are part of
the identified state. It is not:

- a database allocation fingerprint (a fingerprint identifies an allocation
  namespace and can remain unchanged across many different snapshots);
- the local hostname;
- the current local host event namespace;
- the cursor domain;
- a physical replica slot;
- the active/inactive designation;
- the wall-clock merge time;
- the destination journal watermark;
- other host-local operational metadata.

```js
/**
 * The properties that this type carries are:
 * - The value identifies one exact synchronization-relevant source state,
 *   including derived pairwise merge results.
 *
 * The proof of those properties is guaranteed by:
 * - This typedef cannot enforce the property by construction.
 * - Therefore every function that returns this type is part of the proof.
 * - The current return sites are:
 *   - the synchronization staging layer, which derives a checkpoint snapshot
 *     ID from the exact staged checkpoint/revision of a snapshot;
 *   - pairwise merge, which derives a merge snapshot ID from the merge
 *     protocol version, the schema version, and the canonical pair of input
 *     snapshot IDs.
 */
class SourceSnapshotIdClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("SourceSnapshotId cannot be instantiated"); }
}

/** @typedef {SourceSnapshotIdClass} SourceSnapshotId */
```

Conversion functions:

```js
/**
 * Unsafe cast: wraps a string as a SourceSnapshotId.
 * The function is defined only for a checkpoint or merge source-snapshot
 * digest (64 lowercase hexadecimal characters) derived as described below.
 *
 * @param {string} value
 * @returns {SourceSnapshotId}
 */
function unsafeStringToSourceSnapshotId(value)

/**
 * Render a SourceSnapshotId to its string persisted representation.
 * The representation is the fixed-size digest.
 *
 * @param {SourceSnapshotId} snapshotId
 * @returns {string}
 */
function sourceSnapshotIdToString(snapshotId)
```

### Base checkpoint identity

A snapshot directly staged from a host revision receives an identity equivalent
to:

```text
sha256(encode([
    "snapshot-v2",
    "checkpoint",
    versionToString(schemaVersion),
    hostnameToString(hostname),
    sourceRevisionIdToString(revision),
]))
```

The schema version is part of the checkpoint identity, so the same host
revision staged for two different schema versions produces two distinct
checkpoint snapshot IDs.

### Derived merge identity

A deterministic merge output receives an identity equivalent to:

```text
const [lowerId, upperId] = canonicalPair([
    sourceSnapshotIdToString(left),
    sourceSnapshotIdToString(right),
])

sha256(encode([
    "snapshot-v2",
    "merge",
    graphAndJournalMergeProtocolVersion,
    versionToString(schemaVersion),
    lowerId,
    upperId,
]))
```

Every encoded element is an explicitly defined string; the tuple is flattened
so no nested array needs an encoding of its own. `canonicalPair` sorts the two
input snapshot-ID strings using deterministic JavaScript code-unit ordering and
is applied before encoding, not inside the encoded tuple.

`graphAndJournalMergeProtocolVersion` is a deterministic string naming the
merge-protocol semantics. It MUST change whenever graph synchronization or
journal reconciliation semantics can change the derived output. A digest
therefore identifies both the exact inputs and the exact merge algorithm that
produced the result; two runs of different merge algorithms on the same inputs
must not receive the same snapshot ID. Merging is compatible only when both
inputs share the same `graphAndJournalMergeProtocolVersion` and schema version.

`sha256` is the SHA-256 digest of the canonical byte encoding `encode`, rendered
as 64 lowercase hexadecimal characters. `encode` serializes the array
element-wise: a 64-bit big-endian element count, followed for each element by a
64-bit big-endian byte-length prefix and the UTF-8 bytes of that element's
string form. `versionToString(schemaVersion)` is the graph schema/version
identity used for storage namespacing.

Because each snapshot ID is a fixed-size digest, the representation does not
grow with merge depth: a merge ID is always exactly one digest, and event IDs
embed only fixed-size digests.

Consequences:

- reversing the two pairwise inputs produces the same merged snapshot ID;
- different derived source states do not inherit the same identity merely
  because they originated on the same physical host;
- a derived output can safely become an input to another merge;
- the derivation structure is retained in the digest, so two distinct merge
  derivations are not falsely assigned one identity;
- if strict collision handling is desired, associate each digest with its
  canonical preimage and reject a digest/preimage mismatch.

### Incorporation frontier (nominal)

`IncorporationFrontier` is the per-host incorporation frontier of one source
snapshot. It is a canonical immutable mapping conceptually equivalent to:

```
Map<Hostname, SourceRevisionId>
```

For every hostname that contributed to the snapshot, the frontier records the
exact host revision of that hostname that the snapshot has incorporated. The
frontier is persisted as part of `SourceSnapshotProvenance` and is included in
the exact synchronization-relevant state that a `SourceSnapshotId` identifies:
two snapshots with different frontiers are different exact states and receive
different snapshot identities.

The frontier is the single source of the contributor set of a snapshot. The
contributor set of a source snapshot is derived from the frontier's hostname
keys; no independent contributor value is maintained, so the two can never
disagree.

```js
/**
 * The properties that this type carries are:
 * - The value is an immutable mapping from each contributing hostname to the
 *   exact host revision of that hostname already incorporated by the snapshot.
 * - Iteration and persisted serialization are in deterministic canonical order:
 *   hostnames sorted by `hostnameToString` using deterministic JavaScript
 *   code-unit ordering.
 *
 * The proof of those properties is guaranteed by:
 * - `makeInitialIncorporationFrontier(ownHostname, ownRevision)`: constructs
 *   the frontier `{ ownHostname: ownRevision }` for a freshly initialized host.
 * - `localCheckpointIncorporationFrontier(frontier, ownHostname, ownRevision)`:
 *   preserves every remote entry of `frontier` and replaces only the
 *   `ownHostname` entry; it is used for a local checkpoint taken after ordinary
 *   graph activity.
 * - `unionIncorporationFrontiers(left, right)`: computes the union of two
 *   frontiers, retaining the known descendant revision for any hostname present
 *   in both and rejecting the operation when the two revisions are
 *   incomparable.
 * - No mutation operation is exposed on `IncorporationFrontier` values.
 */
class IncorporationFrontierClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("IncorporationFrontier cannot be instantiated"); }
}

/** @typedef {IncorporationFrontierClass} IncorporationFrontier */
```

Conversion functions:

```js
/**
 * Construct the incorporation frontier of a freshly initialized host.
 * The frontier contains exactly `{ ownHostname: ownRevision }`.
 *
 * @param {Hostname} ownHostname
 * @param {SourceRevisionId} ownRevision
 * @returns {IncorporationFrontier}
 */
function makeInitialIncorporationFrontier(ownHostname, ownRevision)

/**
 * Derive the incorporation frontier of a local checkpoint taken after ordinary
 * graph activity. Every remote entry of `frontier` is preserved exactly; only
 * the `ownHostname` entry is replaced with `ownRevision`.
 *
 * @param {IncorporationFrontier} frontier
 * @param {Hostname} ownHostname
 * @param {SourceRevisionId} ownRevision
 * @returns {IncorporationFrontier}
 */
function localCheckpointIncorporationFrontier(frontier, ownHostname, ownRevision)

/**
 * Union two incorporation frontiers. For a hostname present in only one
 * frontier, its entry is retained. For a hostname present in both:
 * - equal revisions are retained;
 * - when one revision is a known descendant of the other, the descendant is
 *   retained;
 * - otherwise the two revisions are incomparable and the operation MUST reject
 *   rather than guess a winner.
 *
 * The union is commutative: `unionIncorporationFrontiers(left, right)` and
 * `unionIncorporationFrontiers(right, left)` produce the same frontier or the
 * same rejection.
 *
 * @param {IncorporationFrontier} left
 * @param {IncorporationFrontier} right
 * @returns {IncorporationFrontier}
 */
function unionIncorporationFrontiers(left, right)

/**
 * Return the revision recorded for a hostname, or `undefined` when the
 * frontier does not contain the hostname.
 *
 * @param {IncorporationFrontier} frontier
 * @param {Hostname} hostname
 * @returns {SourceRevisionId | undefined}
 */
function incorporationFrontierGet(frontier, hostname)

/**
 * Return the hostnames of a frontier in canonical order. The contributor set of
 * a snapshot is derived from this set:
 * `makeSync(incorporationFrontierHostnames(frontier))`.
 *
 * @param {IncorporationFrontier} frontier
 * @returns {ReadonlyArray<Hostname>}
 */
function incorporationFrontierHostnames(frontier)
```

A host revision graph is the per-host history of revisions (for example, the
commits of the host's branch in the shared repository). Two revisions of the
same hostname are comparable through that graph: one may be an ancestor of the
other, or they may be equal. A revision is the **known descendant** of another
when the host revision graph proves the ancestry relationship. Two revisions of
the same hostname are **incomparable** when neither is an ancestor of the other
and they are not equal; this is the normal shape of revisions from different
journal lineages of the same hostname (for example, across a
`reset-to-hostname`). Normal synchronization MUST reject incomparable revisions
rather than guess a winner.

### SourceSnapshotProvenance

Each source replica used by synchronization carries provenance equivalent to:

```js
/**
 * @typedef {object} SourceSnapshotProvenance
 * @property {SourceSnapshotId} id
 * @property {IncorporationFrontier} incorporatedRevisions
 * @property {string} graphAndJournalMergeProtocolVersion
 * @property {Version} schemaVersion
 */
```

For a checkpoint leaf staged directly from a host revision:

```text
id                         = checkpoint source-snapshot ID
incorporatedRevisions      = the host's incorporation frontier at the staged
                             revision: it maps the hostname to exactly that
                             staged revision and preserves every remote
                             revision the host had already incorporated
graphAndJournalMergeProtocolVersion = the currently advertised protocol version
schemaVersion              = the source's schema version
```

For a merge result:

```text
id                         = merge source-snapshot ID
incorporatedRevisions      = unionIncorporationFrontiers(left.incorporatedRevisions,
                             right.incorporatedRevisions)
graphAndJournalMergeProtocolVersion = preserved from the inputs
schemaVersion              = preserved from the inputs
```

The frontier union rejects a merge whose two inputs record incomparable
revisions for a common hostname. This is the rejection rule for a regressed or
incomparable host revision during normal synchronization; see
`incremental-graph-journal-sync.md` § Incorporation frontier and no-op per-host
merges.

The protocol and schema versions are persisted as explicit compatibility
metadata with every synchronization source, stored separately even though they
are also hashed into derived snapshot IDs. Checkpoint staging assigns the
currently advertised protocol version and the source's schema version. Derived
outputs preserve both. Pairwise merge rejects inputs with mismatching protocol
or schema versions before graph or journal reconciliation.

A `SourceSnapshotProvenance` describes one exact synchronization-relevant
source state. Any ordinary graph
or journal mutation (for example a `pull` or `invalidate`) makes existing
exact-snapshot provenance inapplicable to the resulting mutable replica: the
replica is no longer the exact state the provenance identifies. Provenance
for a mutable replica is established only by freezing/checkpointing that
replica into an exact source snapshot and deriving fresh provenance for the
exact frozen state.

At the beginning of synchronization, while graph activity is excluded, the
exact local source is frozen/checkpointed and fresh checkpoint provenance is
derived for that precise local snapshot; this provenance is used as the local
source's provenance for the first per-host merge.

Each derived merge output receives persisted merge provenance before it can
become the next local source.

The merged destination's provenance must be durably established before that
destination can become active or be used as the source of a later per-host
merge. The provenance must survive the root-database reopen that occurs between
successive per-host merges. A failed merge must not publish the destination
provenance.

---

## JournalEntry (internal)

### Shape

`JournalEntry` is a discriminated union. It is discriminated first by the
literal `action`; the `creator` field is fixed per variant so that invalid
action/creator combinations cannot be represented.

```js
/**
 * Fields shared by every journal entry.
 *
 * This type deliberately excludes `action` and `creator`; those fields are
 * supplied by the concrete variants below.
 *
 * @typedef {object} JournalEntryCommon
 * @property {NodeIdentifier} id - The node identifier of the affected node.
 * @property {NodeKey} key - The semantic node key at the time of the change.
 * @property {UnixTimestamp} time - Event provenance and ordering metadata.
 * @property {JournalEventId} eventId - Stable identity of this event.
 */
```

Host-originated entries:

```js
/**
 * @typedef {JournalEntryCommon & {
 *     action: "add",
 *     creator: Hostname,
 * }} AddJournalEntry
 */

/**
 * @typedef {JournalEntryCommon & {
 *     action: "edit",
 *     creator: Hostname,
 * }} EditJournalEntry
 */

/**
 * @typedef {JournalEntryCommon & {
 *     action: "validate",
 *     creator: Hostname,
 * }} ValidateJournalEntry
 */
```

Delete variants:

```js
/**
 * @typedef {JournalEntryCommon & {
 *     action: "delete",
 *     creator: Hostname,
 * }} HostDeleteJournalEntry
 */

/**
 * @typedef {JournalEntryCommon & {
 *     action: "delete",
 *     creator: Sync,
 * }} SyncDeleteJournalEntry
 */

/**
 * @typedef {
 *     HostDeleteJournalEntry |
 *     SyncDeleteJournalEntry
 * } DeleteJournalEntry
 */
```

Invalidate variants:

```js
/**
 * @typedef {JournalEntryCommon & {
 *     action: "invalidate",
 *     creator: Hostname,
 * }} HostInvalidateJournalEntry
 */

/**
 * @typedef {JournalEntryCommon & {
 *     action: "invalidate",
 *     creator: Sync,
 * }} SyncInvalidateJournalEntry
 */

/**
 * @typedef {
 *     HostInvalidateJournalEntry |
 *     SyncInvalidateJournalEntry
 * } InvalidateJournalEntry
 */
```

The final entry type:

```js
/**
 * @typedef {
 *     AddJournalEntry |
 *     EditJournalEntry |
 *     DeleteJournalEntry |
 *     InvalidateJournalEntry |
 *     ValidateJournalEntry
 * } JournalEntry
 */
```

Semantic properties of the union:

- `action` is a literal discriminant.
- `add`, `edit`, and `validate` always have `creator: Hostname`.
- `delete` may be host-originated or sync-derived.
- `invalidate` may be host-originated or sync-derived.
- No valid `JournalEntry` can represent sync-derived `add`, `edit`, or
  `validate`.
- Migration-generated entries are host-originated variants.
- Repositioning or copying an entry preserves its concrete variant.
- Deserialization and integrity validation reject invalid action/creator
  combinations: a `Sync` creator with `add`, `edit`, or `validate`, or a
  `Hostname` creator encoded as a sync-derived event, is rejected.

Internal type guards:

```js
/**
 * @param {unknown} value
 * @returns {value is SyncDeleteJournalEntry | SyncInvalidateJournalEntry}
 */
function isSyncJournalEntry(value)

/**
 * @param {unknown} value
 * @returns {value is
 *     AddJournalEntry |
 *     EditJournalEntry |
 *     HostDeleteJournalEntry |
 *     HostInvalidateJournalEntry |
 *     ValidateJournalEntry}
 */
function isHostJournalEntry(value)

/**
 * Authoritative boundary validator for persisted entries.
 * Recognizes only the concrete JournalEntry variants and rejects invalid
 * action/creator combinations.
 *
 * @param {unknown} value
 * @returns {value is JournalEntry}
 */
function isJournalEntry(value)
```

A sync entry is exactly `SyncDeleteJournalEntry | SyncInvalidateJournalEntry`.
`isSyncJournalEntry` and `isHostJournalEntry` must not recognize invalid
sync/action combinations. Persisted-entry deserialization uses `isJournalEntry`
as the boundary validator before accepting an entry.

The `*Class` declarations throughout this document (e.g. `UnixTimestampClass`, `JournalIndexClass`, `HostnameClass`, `PossibleNodeChangeClass`, `BaselinePossibleNodeChangeClass`) are nominal JSDoc brands. They do not imply that values are constructed with these classes at runtime. As with `NodeIdentifier`, the runtime representation may be a plain value/object that is treated as the branded type only through controlled casts.

A `JournalEntry` is an internal type. Ordinary users of `graph.possibleMaybeChanges` do not receive `JournalEntry` values. The public API surface uses `PossibleNodeChange`.

### Terminology

```
logical event       = immutable historical event identified by eventId
physical occurrence = one storage position containing that event
notification        = exposure of an event after a cursor
```

Moving or copying an event creates no new logical event. A
`SyncDeleteJournalEntry` or `SyncInvalidateJournalEntry` is a new logical event
representing a synchronized merge fact; it does not assert that any single host
locally experienced the transition.

### JournalAction

```js
/**
 * The kind of change recorded in a journal entry.
 * @typedef {'add' | 'edit' | 'delete' | 'invalidate' | 'validate'} JournalAction
 */
```

The action records the reason or category under which the notification was
originated. It is not an exact-once assertion and does not determine current
graph state. Journal coverage has no false negatives for supported graph
changes, but may contain conservative or duplicate notifications.

The action alone does not fix the entry's origin. The concrete `JournalEntry`
variants pair each action with the correct `creator`: `Hostname` for
host-originated entries and `Sync` for sync-derived entries. Only `delete` and
`invalidate` have sync-derived variants.

### Entry semantics

- `AddJournalEntry` (`action: "add"`, `creator: Hostname`) — originated from a
  host-local first materialization.
- `EditJournalEntry` (`action: "edit"`, `creator: Hostname`) — originated from
  a host-local material value change, or retained as notification coverage for
  a possible value change.
- `HostDeleteJournalEntry` (`action: "delete"`, `creator: Hostname`) —
  originated from an actual host-local deletion or migration deletion.
- `SyncDeleteJournalEntry` (`action: "delete"`, `creator: Sync`) — records that
  at least one synchronized source materialized `K` while the deterministic
  merged result does not materialize `K`. It does not claim that every source
  or the host executing the merge experienced a local deletion.
- `HostInvalidateJournalEntry` (`action: "invalidate"`, `creator: Hostname`) —
  originated from a host-local `up-to-date` → `potentially-outdated` transition.
  Concurrent overlapping invalidations may produce redundant host entries.
- `SyncInvalidateJournalEntry` (`action: "invalidate"`, `creator: Sync`) —
  records that at least one synchronized source considered `K` `up-to-date`
  while the deterministic merged result retains `K` as `potentially-outdated`.
  It does not claim that every source or the host executing the merge
  experienced an invalidation.
- `ValidateJournalEntry` (`action: "validate"`, `creator: Hostname`) —
  originated from a host-local successful recomputation that restored an
  already materialized node to `up-to-date`.

A retained freshness entry is immutable provenance for either:

- a host-local freshness transition; or
- a synchronization-derived freshness merge fact.

It does not determine current graph freshness.

A returned action does not necessarily correspond one-to-one with one unique
graph-state transition. Extra, duplicate, or redundant entries are permitted;
logical compaction suppresses redundant entries for query purposes (see
`incremental-graph-journal-api.md`).

---

## Logical journal view

### Purpose

The logical journal view provides one normative semantic operation shared by `possibleMaybeChanges`, physical compaction, and journal reconciliation (see `incremental-graph-journal-sync.md`). It describes which journal entries are logically significant through a fixed watermark, independent of whether redundant physical entries still exist.

This is a semantic definition only: the logical journal view does not create another database, replica, or persisted structure. It is the projection of journal storage through a fixed bound `H`.

### Definition

```
logicalJournalView(journal, H)
```

For a journal whose committed watermark is `last_journal_index = H`, inspect every physically present journal entry at indices `1 .. H`. Ignore absent positions.

For each semantic `NodeKey`, divide surviving entries into exactly two independent categories.

#### State/lifecycle category

```
add
edit
delete
```

Retain only the entry with the greatest `JournalIndex` among these actions for the semantic key.

Call this the key's **latest state entry**.

#### Freshness category

```
invalidate
validate
```

Retain only the entry with the greatest `JournalIndex` among these actions for the semantic key.

Call this the key's **latest freshness entry**.

### Result

The logical journal view is the union, over every semantic node key, of:

- its latest state entry, when one exists;
- its latest freshness entry, when one exists.

It contains at most two entries per semantic node key.

The two categories are independent:

- a state entry (`add`, `edit`, `delete`) never suppresses a freshness entry;
- a freshness entry (`invalidate`, `validate`) never suppresses a state entry;
- `validate` and `invalidate` are not value or lifecycle evidence;
- `add`, `edit`, and `delete` are not freshness evidence.

**Freshness events are immutable provenance, not current graph state.** A
retained `validate` or `invalidate` entry is immutable provenance for either a
host-local freshness transition or a synchronization-derived freshness merge
fact. It does not determine current graph freshness: the current graph
freshness may differ — a later synchronization, invalidation, or recomputation
may have changed it. The canonical freshness history selected by
synchronization is journal history; the graph synchronization rules determine
final graph freshness.

### Invariants

REQ-JT-23: `logicalJournalView` MUST NOT consult current graph state. It depends only on:

- the journal entries and absences;
- the fixed bound `H`;
- semantic `NodeKey`;
- physical `JournalIndex`.

REQ-JT-24: Two entries with equal timestamps and otherwise identical public payload fields may both be retained in the logical view, because they may belong to different categories (one state, one freshness) or different semantic keys.

### Implementation equivalence

An implementation does not need to materialize a second journal or physically run compaction. It may compute the equivalent result by retaining, for each semantic key and category:

- greatest-index `add | edit | delete`;
- greatest-index `invalidate | validate`.

The normative meaning remains logical compaction through `H` — retaining only the semantically relevant entries per key and category.

---

## UnixTimestamp

`UnixTimestamp` is an integer count of milliseconds since the Unix epoch (January 1, 1970, 00:00:00 UTC). This is consistent with JavaScript's `Date.now()` and `Date.prototype.getTime()`.

REQ-JT-01: The unit of `UnixTimestamp` MUST be integer milliseconds. Fractional timestamps MUST NOT be used.

REQ-JT-02: The persisted representation of `UnixTimestamp` is a numeric integer (JavaScript `number`).

REQ-JT-03: Implementations SHOULD record journal timestamps for ordinary host
events using the local system clock at the time of emission. Host clocks are
not assumed to be synchronized across hosts. Sync-derived events MUST NOT use
the wall clock of the host executing synchronization; their `time` is derived
deterministically from source journal evidence (see
`incremental-graph-journal-sync.md`).

### Unified public meaning of `time`

`time` is event provenance and ordering metadata:

- For an ordinary host event, it is the host wall-clock time at origination.
- For a sync-derived event, it is deterministic provenance time derived from
  the source journal evidence for the semantic key. It is not the wall-clock
  instant at which a particular host executed synchronization.

Because `creator` is not exposed through `PossibleNodeChange`, a returned
`time` is not guaranteed to be an exact local occurrence time.

Journal timestamps provide human-readable event ordering metadata. Graph synchronization uses graph `modifiedAt` timestamps, not journal timestamps, for conflict resolution.

### Nominal typing

`UnixTimestamp` follows the same nominal class pattern as `NodeIdentifier`:

```js
class UnixTimestampClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("UnixTimestamp cannot be instantiated"); }
}

/** @typedef {UnixTimestampClass} UnixTimestamp */
```

Conversion functions:

```js
/**
 * Unsafe cast: wraps a number as a UnixTimestamp.
 * The function is defined only for finite, non-negative integer values
 * representing milliseconds since the Unix epoch. Values outside that
 * domain do not produce a valid UnixTimestamp. Implementations SHOULD
 * validate this in debug builds.
 *
 * @param {number} value
 * @returns {UnixTimestamp}
 */
function unsafeNumberToUnixTimestamp(value)

/**
 * Render a UnixTimestamp to its numeric persisted representation.
 *
 * @param {UnixTimestamp} timestamp
 * @returns {number}
 */
function unixTimestampToNumber(timestamp)
```

---

## Hostname

A `Hostname` is a string that uniquely identifies a host within the synchronization mesh. The specific source of the value (e.g., machine hostname, configured name, stable UUID) is implementation-defined, but the value MUST be stable across restarts of the same host.

Arbitrary strings must not automatically count as `Hostname`; the nominal
type is produced only through the controlled conversion functions below.

REQ-JT-04: A `Hostname` MUST be stable for a given host across process restarts and reboots.

REQ-JT-05: Two distinct hosts in the synchronization mesh MUST have different `Hostname` values. Because event identity depends on `Hostname`, duplicate host identity is invalid configuration. Synchronization MUST reject a mesh containing two distinct hosts with the same `Hostname`.

REQ-JT-06: `Hostname` MUST be a non-empty string. Implementations MAY impose additional restrictions (e.g., no whitespace, character set limits) based on the host identification source. Empty strings MUST NOT be accepted as `Hostname` values.

### Nominal typing

`Hostname` follows the same nominal class pattern:

```js
class HostnameClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("Hostname cannot be instantiated"); }
}

/** @typedef {HostnameClass} Hostname */
```

Conversion functions:

```js
/**
 * Unsafe cast: wraps a string as a Hostname.
 * The function is defined only for non-empty strings that uniquely identify
 * a host in the synchronization mesh and are stable across restarts.
 * Passing a value outside this domain is undefined behavior.
 *
 * @param {string} value
 * @returns {Hostname}
 */
function unsafeStringToHostname(value)

/**
 * Render a Hostname to its string persisted representation.
 *
 * @param {Hostname} hostname
 * @returns {string}
 */
function hostnameToString(hostname)
```

---

## Sync

`Sync` is a nominal immutable set of participating `Hostname` values. It is the
`creator` of sync-derived events: the set describes the hosts whose exact source
snapshots participated in deriving the event. It does not identify one host as
the actor.

The contributor set of a source snapshot is derived from that snapshot's
incorporation frontier and is never maintained as an independent value: for a
snapshot whose frontier is `F`, the contributor set is
`makeSync(incorporationFrontierHostnames(F))` (see `Incorporation frontier`).
Because a merge unions the two input frontiers, the merged contributor set is
exactly the union of the two input contributor sets.

Although it is conceptually a set, its runtime iteration and persisted
serialization order must be deterministic:

1. remove duplicates;
2. sort by `hostnameToString` using deterministic JavaScript code-unit
   ordering;
3. insert or serialize in that canonical order;
4. prohibit mutation after construction.

```js
/**
 * The properties that this type carries are:
 * - The value is an immutable set of participating source hostnames.
 * - Iteration and persisted serialization are in deterministic canonical order:
 *   deduplicated, then sorted by `hostnameToString` using deterministic
 *   JavaScript code-unit ordering.
 *
 * The proof of those properties is guaranteed by:
 * - `makeSync(hostnames)`: deduplicates the input hostnames and sorts them into
 *   canonical order before constructing the value, and the resulting structure
 *   is immutable.
 * - No mutation operation is exposed on `Sync` values.
 */
class SyncClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("Sync cannot be instantiated"); }
}

/** @typedef {SyncClass} Sync */
```

Conversion functions:

```js
/**
 * Construct a Sync set from hostnames.
 * Deduplicates and sorts into canonical order by hostnameToString.
 * The result is immutable.
 *
 * @param {Array<Hostname>} hostnames
 * @returns {Sync}
 */
function makeSync(hostnames)

/**
 * Return the hostnames of a Sync set in canonical order.
 * Returns an immutable snapshot or a fresh detached array; mutating the
 * returned value must not be able to mutate the Sync set.
 *
 * @param {Sync} sync
 * @returns {ReadonlyArray<Hostname>}
 */
function syncToHostnames(sync)
```

For one pairwise merge of snapshots owned by hosts A and B, a generated sync
event has `creator = Sync{A, B}`.

---

## JournalCreator

```js
/**
 * The creator of a logical journal event.
 * A `Hostname` for ordinary host-originated events; a `Sync` set for
 * sync-derived events.
 *
 * @typedef {Hostname | Sync} JournalCreator
 */
```

`JournalCreator` is a helper alias for shared utilities. It is not used as the
`creator` type of every `JournalEntry`: the concrete entry variants pair each
action with the correct creator kind (see `JournalEntry`). A `JournalCreator`
is never exposed through the public `PossibleNodeChange` type. It is
journal-internal provenance used during synchronization.

### Creator serialization

```js
/**
 * Structurally tagged serialized form of a JournalCreator.
 *
 * @typedef {["host", string] | ["sync", Array<string>]} SerializedJournalCreator
 */
```

Serialization is exactly:

```js
serializeJournalCreator(hostname) = ["host", hostnameToString(hostname)]
serializeJournalCreator(sync)     = ["sync", syncToHostnames(sync).map(hostnameToString)]
```

The hostname array is already deduplicated and canonically ordered by `Sync`.
The tagged representation is injective: a raw hostname string can never be
mistaken for the serialized form of a `Sync` set, and vice versa.

When a deterministic string is needed for ordering:

```js
journalCreatorToString(creator) = JSON.stringify(serializeJournalCreator(creator))
```

The same tagged representation is used for persisted creator encoding,
integrity comparison, deterministic fresh-placement ordering, examples, tests,
and debug output where canonical creator rendering is required. A raw hostname
string is not used as the complete serialized `Hostname` creator
representation.

---

## JournalIndex

A `JournalIndex` is a replicated physical journal position within the journal storage system. It is NOT exposed in the public `graph.possibleMaybeChanges` API signature.

REQ-JT-07: `JournalIndex` values MUST NOT be reused.

REQ-JT-08: Gaps in the `JournalIndex` sequence are acceptable.

REQ-JT-09: `JournalIndex` MUST NOT be exposed in the public `graph.possibleMaybeChanges` API signature.

### Nominal typing

```js
class JournalIndexClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("JournalIndex cannot be instantiated"); }
}

/** @typedef {JournalIndexClass} JournalIndex */
```

REQ-JT-10: `JournalIndex` represents a real journal index. Only positive integers (≥ 1) are valid real journal indices. The value `0` is NOT a valid `JournalIndex` value; it serves as the initial `last_journal_index` watermark before any journal entry has been committed, mirroring the `last_node_index` convention (see `docs/specs/incremental-graph-last-node-index.md`). Sentinel values that represent "before any entry" (e.g., -1, 0) are NOT `JournalIndex` values. See `PrivateSincePosition` for the internal since-position encoding.

Conversion functions:

```js
/**
 * Unsafe cast: wraps a positive integer (≥ 1) as a JournalIndex.
 * The function is defined only for positive integers representing a real
 * journal position. Passing a value outside this domain is undefined behavior.
 *
 * @param {number} value
 * @returns {JournalIndex}
 */
function unsafeNumberToJournalIndex(value)

/**
 * Render a JournalIndex to its numeric persisted representation.
 *
 * @param {JournalIndex} index
 * @returns {number}
 */
function journalIndexToNumber(index)
```

### Journal index allocation and storage

JournalIndex allocation happens during darkroom finalization, atomically with the durable commit. A transaction prepares unindexed journal entries during its unlocked body. When it enters darkroom, it allocates a fresh contiguous range strictly above the current committed watermark, adds those indexed entries and the new watermark to the same batch, and commits them atomically.

The last committed journal index watermark is stored in global metadata:

```
rendered/r/global/last_journal_index
```

REQ-JT-11: `last_journal_index` MUST NOT decrease. A fresh replica starts with `last_journal_index = 0`. The first committed journal entry uses index `1`, mirroring the `last_node_index` convention. The volatile next-index counter is updated only after a successful durable flush, never speculatively.

REQ-JT-12: After synchronization, `last_journal_index` MUST be at least the greatest index that is present or known-absent due to synchronized journal state. A known-absent index still contributes to the watermark so that future local allocations do not reuse or overwrite an index that another synchronized host has already allocated, compacted, or poisoned.

### Global established-position invariant

Once a journal position is established by a committed watermark `last_journal_index = H`, its state is governed by the following rules. These rules apply globally to all operations — ordinary appends, migration, sync, and compaction.

REQ-JT-13: An established journal position MUST remain unchanged or become absent.

REQ-JT-14: An established absence MUST remain absent.

REQ-JT-15: No operation may replace or rewrite an established `JournalEntry`.

REQ-JT-16: All new journal evidence MUST be appended at fresh indices strictly greater than the current committed watermark.

The only permitted state transition for an established position is:

```
present entry → absent
```

This transition is allowed only for these specifically authorized structural operations:
- **Compaction**: may delete entries outside `logicalJournalView(journal, H)` while holding `closeGarden` (see `incremental-graph-journal-compaction.md`).
- **Synchronization normalization**: the named journal-reconciliation phase that produces the physically canonical destination journal may delete established entries while holding `closeGarden`. Its permitted deletions are exactly the five kinds specified in `incremental-graph-journal-sync.md` § Synchronization normalization: same-index poisoning, established-absence propagation, logical-view pruning, duplicate occurrence normalization, and carrier repositioning.

No other deletion of an established entry is permitted. In particular, ordinary
appends, migration, and any synchronization activity outside the
synchronization-normalization phase MUST NOT delete an established entry.

The following transitions are forbidden globally, even under `closeGarden`:

```
absent → present                  (fill an established absence)
entry A → entry B                 (replace an established entry)
entry → modified version of entry (rewrite or reinterpret content)
```

**Migration** MUST preserve all established journal positions exactly. Migration may only preserve existing entries and absences and append fresh entries. It MUST NOT delete, fill, replace, rewrite, poison, or reinterpret any established position. See `incremental-graph-journal-migrations.md`.

### Published-prefix invariant

The garden design works only if ordinary appends obey a strong finalized-prefix invariant.

REQ-JT-17: For a replica whose committed watermark is `last_journal_index = H`, all positions at or below `H` are finalized with respect to ordinary append-only operations.

For every `i ≤ H`, the position is one of:

- a committed journal entry whose contents ordinary appenders will never change; or
- an established absent gap that ordinary appenders will never fill.

REQ-JT-18: Ordinary append-only operations (including `pull` and `invalidate` entry commits) MUST NOT:

- insert at an index `≤ H`;
- fill an old gap at an index `≤ H`;
- replace an entry at an index `≤ H`;
- delete an entry at an index `≤ H`;
- change the contents of an entry at an index `≤ H`.

Ordinary appends may only allocate fresh indices strictly greater than the previously committed watermark.

### Atomic publication

REQ-JT-19: The new journal entry and the advancement of `last_journal_index` MUST be committed in the same atomic durable batch. Therefore a reader of `last_journal_index` observes either:

- the state before the append; or
- the state after both the entry and its watermark have committed.

It must never observe a watermark that exposes a not-yet-committed ordinary append.

REQ-JT-20: Gaps in the journal index sequence are allowed. They may be caused by compaction or by the synchronization-normalization phase (same-index poisoning, established-absence propagation, logical-view pruning, duplicate occurrence normalization, and carrier repositioning; see `incremental-graph-journal-sync.md` § Synchronization normalization). Gaps caused by failed transactions are NOT possible under the commit-time allocation model, because index allocation occurs only during the durable commit, which either succeeds or fails atomically. Once a later watermark publishes a prefix containing a gap, ordinary appenders MUST NEVER fill that gap.

---

## Journal lineage

The established-position invariants and watermark monotonicity (REQ-JT-11
through REQ-JT-20) hold within one journal lineage. A journal lineage is the
installed graph-and-journal state produced by a sequence of ordinary operations:

- ordinary journal append;
- compaction;
- migration preserving the established prefix;
- normal pairwise journal reconciliation;
- ordinary active-replica cutover associated with those operations.

### Reset-to-hostname discontinuity

`reset-to-hostname` (see `incremental-graph-synchronization.md`) is different.
It replaces the whole installed graph-and-journal state with a selected
snapshot and is not modeled as mutation of individual established positions in
the old lineage.

- A successful reset ends the currently installed lineage and installs the
  selected snapshot as a new local journal lineage.
- The reset journal adopts the selected snapshot's journal and watermark
  exactly. The new watermark may be numerically lower than the old lineage's
  watermark.
- A successful reset generates a fresh host event namespace (see
  `Host event namespace`), so numeric index reuse in the new lineage cannot
  collide with old-lineage host event IDs.
- No journal-notification continuity is specified across reset.
- The old and new journal positions are not one shared index namespace.

Watermark monotonicity and the established-position invariants continue to hold
within each lineage individually.

### Cursor domain rotation on reset

A successful reset must create and publish a fresh `JournalCursorDomain`:

1. Keep the old domain active while constructing the reset destination.
2. Construct the destination to contain its journal, watermark, source
   provenance where applicable, and a fresh host event namespace, all durably
   stored inside the destination replica.
3. Complete and durably validate the destination.
4. Atomically switch the active replica. The pointer switch selects a
   destination that already contains its fresh host event namespace.
5. Publish the fresh cursor domain and the in-memory cache of the new host
   event namespace.
6. Reject every `PossibleNodeChange` token registered in the old domain.

Only volatile state — the in-memory namespace cache and the new cursor domain —
is published after the pointer switch. The durable namespace is part of the
destination, so a crash after cutover cannot leave the newly active lineage
with an old or missing namespace.

A failed reset preserves:

- the previous active replica;
- the previous journal lineage;
- the previous cursor domain;
- the previous host event namespace;
- the validity of existing same-process tokens under the old state.

### Cursor domain rotation on migration

Migration is a schema change performed through an active-replica cutover. A
successful migration cutover publishes a fresh `JournalCursorDomain`:

1. Keep the old domain active while constructing the migration destination.
2. Complete and durably validate the destination.
3. Atomically switch the active replica.
4. Publish a fresh cursor domain.
5. Reject every `PossibleNodeChange` token registered in the old domain.

A failed migration preserves the previous active replica, journal lineage,
cursor domain, host event namespace, and the validity of existing same-process
tokens under the old state. Migration preserves the established journal
lineage and the current local host event namespace; it rotates only the cursor
domain.

Normal pairwise synchronization preserves the existing cursor domain.
Successful reset and migration cutovers rotate it. `BaselinePossibleNodeChange`
remains the baseline sentinel and is not tied to one cursor domain.

---

## Private cursor state (internal)

The journal module owns private cursor state associating a public token with
its internal journal index. This is NOT exposed through the public type.

```js
/**
 * @typedef {object} CursorState
 * @property {JournalCursorDomain} ownerDomain
 * @property {JournalIndex} index
 */
```

One `JournalCursorDomain` belongs to one running graph service/session. It is
created outside an individual `IncrementalGraph` instance and survives database
closing, active-replica cutover, root-database reopening, and reconstruction of
`IncrementalGraph` during normal synchronization. Every graph instance
constructed for that same running service receives the same domain.
Independently initialized graph services receive different domains, even within
the same JavaScript process. A successful `reset-to-hostname` or successful
migration cutover publishes a fresh domain and rejects tokens registered in the
old domain (see `Journal lineage`).

The state is stored in a module-private `WeakMap<PossibleNodeChange, CursorState>`.
Equivalent module-private storage is acceptable.

- A token is registered only when returned by `possibleMaybeChanges`.
- `since` lookup verifies that the token is known.
- Lookup verifies that its stored `ownerDomain` equals the receiving graph's
  domain.
- A token from another domain, an unknown token, and a forged token are rejected
  by one explicit cursor error.

---

## PossibleNodeChange (public)

### Purpose

`PossibleNodeChange` is the public unit of journal observation. It is an
immutable public projection containing only:

```
nodeName
bindings
action
time
```

It is returned by `graph.possibleMaybeChanges` and may be passed back as the
`since` argument to a later call in the same process session. Every
`PossibleNodeChange` is derived from a committed journal entry.

The public fields are accurate immutable historical data. The value is frozen
or otherwise immutable: `bindings` and nested `ConstValue` data are an immutable
snapshot, so later mutation of the returned value cannot alter the historical
fields.

```js
class PossibleNodeChangeClass {
    /** @private @type {undefined} */ __brand;
    constructor() {
        if (this.__brand !== undefined)
            throw new Error("PossibleNodeChange cannot be instantiated externally");
    }

    /** @readonly @type {NodeName} */
    nodeName;

    /** @readonly @type {ReadonlyArray<ConstValue>} */
    bindings;

    /** @readonly @type {JournalAction} */
    action;

    /** @readonly @type {UnixTimestamp} */
    time;
}

/**
 * Immutable public projection of a journal entry.
 *
 * The raw journal index is stored in a module-private WeakMap, not
 * as an own property, enumerable property, or symbol property. It is
 * not inspectable through the token.
 *
 * @typedef {PossibleNodeChangeClass} PossibleNodeChange
 */
```

Construction is a journal-module-internal operation conceptually equivalent to:

```text
makePossibleNodeChange(entry, index, ownerDomain)
```

It must:

1. create a fresh public projection with the four public fields;
2. deeply snapshot and freeze `bindings` and nested `ConstValue` data;
3. freeze the public token;
4. register `{ ownerDomain, index }` in the private `WeakMap`;
5. return the nominally cast public token.

**This specification covers only same-process, in-memory journal token usage.** A
`PossibleNodeChange` returned during a process session is valid as `since` for
subsequent calls within that same session. Specifically, within the same
process:

- A `PossibleNodeChange` cursor remains valid across **physical compaction**.
  The private journal index persists even if its backing entry is physically
  deleted. A later query scans strictly after that index and tolerates absent
  entries (see `incremental-graph-journal-compaction.md`).
- A `PossibleNodeChange` cursor remains valid across **normal pairwise
  synchronization and its associated active-replica cutover** in the same
  process. The token's `ownerDomain` survives database closing and
  `IncrementalGraph` reconstruction. The notification coverage rules in
  `incremental-graph-journal-sync.md` ensure that any change observable to the
  cursor is reported through repositioned canonical events. Normal pairwise
  synchronization preserves the cursor domain; a wholesale `reset-to-hostname`
  rotates the domain and rejects tokens registered in the old domain (see
  `Journal lineage`).
- A `PossibleNodeChange` cursor is **not portable** to another process or host
  without additional serialization mechanisms that are not specified by this
  specification.

Persistence of these tokens across process restarts, synchronization boundaries
that involve heterogeneous hosts without the notification protocol, or
migration/schema boundaries, and the corresponding long-lived validity
guarantees, are out of scope for this specification and deferred to a future
computor/cursor-persistence specification.

A successful migration cutover publishes a fresh cursor domain and rejects
tokens registered in the old domain; a failed migration preserves the old
domain (see `Journal lineage`).

REQ-JT-21: The public `PossibleNodeChange` API consists exactly of `nodeName`,
`bindings`, `action`, and `time` as public read-only fields. Private journal
fields (`id`, `key`, `creator`, `eventId`, `index`) are outside the public API
and not part of the public nominal type.

REQ-JT-22: A `PossibleNodeChange` returned by `graph.possibleMaybeChanges` MUST
have `nodeName` and `bindings` that correspond to a valid node key in the graph
at the time the change was recorded.

---

## BaselinePossibleNodeChange (public)

`BaselinePossibleNodeChange` is returned by `baselinePossibleNodeChange()`. Its only significant property is that it is less than any real `JournalIndex`.

```js
class BaselinePossibleNodeChangeClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("BaselinePossibleNodeChange cannot be instantiated externally"); }
}

/** @typedef {BaselinePossibleNodeChangeClass} BaselinePossibleNodeChange */
```

When passed as `since`, scanning starts from the first journal entry.

---

## Journal-internal since-position encoding

Internally, the journal module converts the public `since` value into a
private cursor position using the module-private `WeakMap<PossibleNodeChange, CursorState>`:

```js
/**
 * Journal module only.
 *
 * @typedef {{ kind: 'baseline' } | { kind: 'journal', index: JournalIndex, ownerDomain: JournalCursorDomain }} PrivateSincePosition
 */
```

If `since` is `BaselinePossibleNodeChange`, this yields `{ kind: "baseline" }`
— a position less than any real journal index.

If `since` is `PossibleNodeChange`, the module looks up the token in the
private `WeakMap`:

- If the token is unknown or forged, throw a single explicit cursor error.
- If the token's stored `ownerDomain` does not equal the receiving graph's
  domain, throw the same error.
- Otherwise yield `{ kind: "journal", index, ownerDomain }`, scanning strictly
  after that `index`.

---

## Nominal boundary summary

`PossibleNodeChange` and `BaselinePossibleNodeChange` are nominal public
journal tokens with different public semantics:

- `PossibleNodeChange`: immutable public projection of a journal entry with
  meaningful fields (`nodeName`, `bindings`, `action`, `time`). The raw journal
  index is stored in a module-private `WeakMap`, not on the token itself.
- `BaselinePossibleNodeChange`: a position less than any real journal index.
  It is not derived from a journal entry. `baselinePossibleNodeChange()` may
  return one immutable singleton. It carries no journal index and is valid for
  every graph because it always means "before the first entry."

The conversion directions are:

| Direction | Mechanism | Permitted in |
|-----------|-----------|--------------|
| Register | `WeakMap.set(token, state)` when returning from `possibleMaybeChanges` | Journal modules only |
| Lookup | `WeakMap.get(token)` during `since` resolution | Journal modules only |
| Public | `graph.possibleMaybeChanges` returns | Public API |

```
┌──────────────────────────────────────────────┐
│              Public API boundary             │
│                                              │
│  graph.possibleMaybeChanges({                │
│      since,                                  │
│      to,                                     │
│  }): Promise<Array<PossibleNodeChange>>     │
│                                              │
│  baselinePossibleNodeChange():               │
│      BaselinePossibleNodeChange              │
│                                              │
│  PossibleNodeChange fields:                  │
│      nodeName, bindings, action, time        │
│      (immutable, no inspectable index)       │
└──────────────────────────────────────────────┘
```


## Testable scenarios

### E1 — Add entry is host-originated

An `AddJournalEntry` has `action: "add"` and `creator: Hostname`. No
`JournalEntry` value can have `action: "add"` with a `Sync` creator.

### E2 — Sync delete entry is sync-derived

A `SyncDeleteJournalEntry` has `action: "delete"` and `creator: Sync`. Its
`eventId` derives from the exact source-snapshot identities, the action, and
the key.

### E3 — Sync-derived add is rejected

Deserialization or integrity validation rejects any payload that pairs
`action: "add"` with a `Sync` creator. `isSyncJournalEntry` does not recognize
it.

### E4 — Sync validate is rejected

Deserialization or integrity validation rejects any payload that pairs
`action: "validate"` with a `Sync` creator. A `ValidateJournalEntry` always has
`creator: Hostname`.

### E5 — Creator serialization is injective

`Hostname('["a","b"]')` serializes to:

```
["host", "[\"a\",\"b\"]"]
```

while `Sync{Hostname("a"), Hostname("b")}` serializes to:

```
["sync", ["a", "b"]]
```

The tagged representations are distinct, so the two creators never collide.

### E6 — Checkpoint identity includes the schema version

Host A's revision R staged for schema V1 receives a checkpoint ID:

```
sha256(encode(["snapshot-v2", "checkpoint",
               versionToString(V1), hostnameToString(A),
               sourceRevisionIdToString(R)]))
```

The same revision R staged for schema V2 receives a different checkpoint ID,
because `versionToString(V2) ≠ versionToString(V1)`. The two snapshots cannot
be confused even though host and revision match.

### E7 — Frontier descendant retention and incomparability

Host H has a linear revision history `r1 → r2 → r3`.

- Frontier `F1 = { H: r1 }` and `F2 = { H: r3 }` union to `{ H: r3 }`: `r3` is a
  known descendant of `r1`, so the descendant is retained.
- Frontier `F1 = { H: r1 }` and `F3 = { H: r1 }` union to `{ H: r1 }`: equal
  revisions are retained.
- Frontier `F1 = { H: r1 }` and `F4 = { H: r' }`, where `r'` is from a
  different lineage of H (for example, after a reset) and is incomparable with
  `r1`: `unionIncorporationFrontiers(F1, F4)` rejects rather than guessing a
  winner.

### E8 — Contributor set derives from the frontier

A snapshot whose frontier is `{ A: rA, B: rB, C: rC }` has contributor set
`makeSync(incorporationFrontierHostnames(frontier)) = Sync{A, B, C}`. The
contributor set is never stored independently, so it cannot disagree with the
frontier.

---

## Out of scope

This specification does not cover:

- Persistence/serialization of public journal tokens.
- Long-lived cursor validity policies.
- Checkpoint/lease-based compaction safety.
