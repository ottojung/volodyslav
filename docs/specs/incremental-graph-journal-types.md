# IncrementalGraph Journal Types

## Purpose

This document defines the core types used by the IncrementalGraph journal: journal entries, timestamps, host identifiers, journal indices, and the public `PossibleNodeChange` and `BaselinePossibleNodeChange` tokens.

All journal types follow the existing nominal/opaque typing discipline used by `NodeIdentifier`, `NodeKeyString`, `NodeName`, and related IncrementalGraph types. See `backend/src/generators/incremental_graph/database/types.js` and `docs/specs/keys-design.md` for the established patterns.

## Transport boundary

The IncrementalGraph, its journal, and their synchronization semantics are
completely independent of the mechanism used to store or exchange snapshots.
They never refer to or depend on Git, commits, commit hashes, branches,
repository revisions, repository ancestry, working trees, filesystem snapshots,
remote repositories, or transport-specific version identifiers.

An external **transport adapter** is responsible only for:

- obtaining an encoded logical snapshot from another host;
- decoding and validating that snapshot;
- supplying it to IncrementalGraph synchronization;
- storing or transmitting exported snapshots.

The adapter may use any transport. The IncrementalGraph receives only logical
data, conceptually equivalent to:

```js
/**
 * The canonical logical graph projection carried by a snapshot. It is the
 * deterministic `projectGraph` result over the snapshot's merge basis
 * (incremental-graph-synchronization.md § 1c).
 *
 * @typedef {object} LogicalGraphState
 * @property {NodeIdentifierLookup} identifierLookup
 * @property {NodeValueStore} nodeValues
 * @property {FreshnessMarkers} freshnessMarkers
 * @property {ValidityRelation} validity
 * @property {DependencyEdges} dependencyEdges
 */
```

```js
/**
 * A transport-neutral logical snapshot exchanged between hosts.
 *
 * @typedef {object} ReplicaSnapshot
 * @property {LogicalSnapshotId} snapshotId
 * @property {Version} schemaVersion
 * @property {string} mergeProtocolVersion
 * @property {LogicalGraphState} graphState
 * @property {LogicalJournalView} journalState
 * @property {CausalFrontier} causalFrontier
 * @property {MergeBasis} mergeBasis
 */
```

No transport revision, transport ancestry, branch name, remote name, repository
path, or storage-provider identity may cross this boundary. The specifications
in this document set remain valid regardless of whether snapshots are exchanged
through a database, an object store, a removable disk, a peer-to-peer protocol,
or another future transport. Repository-specific behavior, if any, belongs in a
separate adapter or integration specification, never in the IncrementalGraph,
journal, synchronization, emission, compaction, or migration specifications.

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
    hostInstanceIdToString(instanceId),
    journalIndexToNumber(originIndex),
]);
```

`instanceId` is the immutable `HostInstanceId` of the storage instance active
when the event's original index was allocated. The instance identity
disambiguates event and version sequences if the same hostname later
initializes unrelated storage; within one storage instance the journal has a
single monotonic index namespace, so no index is reused under the same event
ID.

Use exactly this tagged fixed-order tuple passed to `JSON.stringify`. No other
host-event format, version tag, custom serialization format, or optional
event-ID fields.

### HostInstanceId (nominal)

`HostInstanceId` is the immutable identity of one local IncrementalGraph
storage instance.

- It is generated only when a genuinely new local storage instance is
  initialized.
- It is stable for the lifetime of that storage instance.
- It is unchanged by reset, migration, synchronization, compaction, and replica
  cutover.
- It disambiguates event and version sequences if the same hostname later
  initializes unrelated storage.
- Because host event identity is `["host", hostname, hostInstanceId,
  originIndex]`, two unrelated storage instances of the same hostname cannot
  collide even when they reuse numeric indices.

```js
/**
 * The properties that this type carries are:
 * - The value identifies one immutable local IncrementalGraph storage instance.
 * - It is generated only when a genuinely new storage instance is initialized
 *   and is stable for that instance's lifetime; it never changes on reset,
 *   migration, synchronization, compaction, or replica cutover.
 *
 * The proof of those properties is guaranteed by:
 * - This typedef cannot enforce the property by construction.
 * - Therefore every function that returns this type is part of the proof.
 * - The current return site is:
 *   - local storage-instance initialization, which allocates a fresh
 *     HostInstanceId and never regenerates it.
 */
class HostInstanceIdClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("HostInstanceId cannot be instantiated"); }
}

/** @typedef {HostInstanceIdClass} HostInstanceId */
```

Conversion functions:

```js
/**
 * Unsafe cast: wraps a string as a HostInstanceId.
 * The function is defined only for a storage-instance identifier generated at
 * local initialization.
 *
 * @param {string} value
 * @returns {HostInstanceId}
 */
function unsafeStringToHostInstanceId(value)

/**
 * Render a HostInstanceId to its string persisted representation.
 *
 * @param {HostInstanceId} instanceId
 * @returns {string}
 */
function hostInstanceIdToString(instanceId)
```

#### Sync-derived event

A sync-derived event must be identified from the complete joined journal
evidence and the semantic event identity, so that every grouping of the same
host contributions derives the same event ID. The event identity is a canonical
function of the evidence, not of the two immediate source snapshots.

The sync event ID is a canonical function of the complete joined journal
evidence, independent of the two immediate source snapshots:

```js
const eventId = JSON.stringify([
    "sync-v2",
    graphAndJournalMergeProtocolVersion,
    action,
    nodeKeyToString(key),
    unixTimestampToNumber(derivedTime),
]);
```

`derivedTime` is the canonical sync event time derived from the joined evidence
(`incremental-graph-journal-sync.md` § Derive sync-derived merge facts). The
event ID includes `graphAndJournalMergeProtocolVersion` and the derived time so
that different protocols or different accumulated evidence produce different
event IDs, and the ID never depends on which two snapshots performed the join.
The identity applies only to `SyncDeleteJournalEntry` and
`SyncInvalidateJournalEntry`.

Consequences:

- the same represented host contributions produce the same event ID regardless
  of pairwise grouping or order;
- a recomputed fact with a larger derived time receives a new event ID and the
  earlier fact is logically superseded;
- repeated placement of the same sync event is deduplicated by `eventId`;
- one `eventId` still identifies exactly one immutable payload (the ID encodes
  the derived time, so a payload cannot change under a fixed ID);
- if the same sync event ID is encountered with different payloads,
  synchronization fails as a journal-integrity error.

A sync event ID must not depend on:

- the two immediate source snapshots;
- the host executing reconciliation;
- local versus remote naming;
- local wall-clock execution time;
- the new physical journal index assigned during placement;
- any transport revision or storage location.

### HostStateVersion (nominal)

`HostStateVersion` is a transport-independent monotonically increasing logical
version scoped to one `(Hostname, HostInstanceId)` pair. It is a non-negative
integer drawn from an explicitly ordered logical sequence. It must not be a
hash, a repository revision, a timestamp, or a storage-layer identifier.

A host advances its own `HostStateVersion` atomically when it originates a
durable graph or journal contribution that another replica may need to
incorporate. It does not advance for exporting or checkpointing the current
state, persisting synchronization metadata, learning that another host has
advanced, merging an unchanged remote snapshot, updating the causal frontier,
or any other synchronization-only activity.

### Local host-state coordinate (persisted metadata)

The local host's current state coordinate is persisted in canonical replica
metadata:

```text
localHostStateCoordinate = {
    instanceId,
    version,
}
```

This coordinate is the local hostname's entry in every exported causal
frontier. A freshly initialized storage instance begins at
`HostStateVersion = 0`.

### Durable commit rules

**One successful host-originated durable transaction advances `HostStateVersion`
exactly once.** A transaction may originate several journal entries (for example
`edit` followed by `validate`) but advances the version only once for the
complete atomic state transition.

During darkroom finalization:

1. Read the currently committed `HostStateVersion`.
2. Allocate its unique successor.
3. Allocate journal indices and construct host event IDs as already specified.
4. Add the graph mutations, the merge-basis candidate/evidence mutations, the
   journal entries, the journal watermark, and the successor host version to
   the same durable batch.
5. Commit the batch atomically.
6. Publish volatile counters only after the durable commit succeeds.

A failed batch must leave all of the following unchanged: graph state; the
merge basis; journal state; `last_journal_index`; `HostStateVersion`; and
volatile next-version state.

No-op operations must not advance the version and must not mutate the merge
basis:

- cache-hit pull;
- repeated invalidation of an already stale node;
- failed recomputation;
- failed transaction;
- export;
- compaction;
- synchronization-only changes;
- replica reopening or switching.

Concurrent host-originated transactions MUST serialize version allocation
through the same finalization discipline, so they cannot receive the same
successor or publish changes out of version order. This rule makes the following
failures impossible: new graph or journal state becomes durable while the
exported causal frontier still advertises the old host version; new graph state
is published with a stale merge basis; and new merge-basis evidence is published
with an old graph or frontier coordinate.

### Merge-basis maintenance

The merge basis (see `incremental-graph-synchronization.md` § 1c) is
synchronization-critical state and is updated atomically whenever host-originated
graph state changes. The durable batch that commits a host-originated change
also commits the corresponding candidate and evidence mutations.

Per operation:

- **First materialization**: creates one `MaterializedCandidate` for the key
  (with its value, timestamps, identifier, empty input candidate references, and
  `up-to-date` freshness), plus an `up-to-date` `FreshnessFact`.
- **Changed recomputation**: creates a new `MaterializedCandidate` (new origin,
  new value/timestamps) for the key, recording the exact input candidate IDs
  the new value was computed against, plus an `up-to-date` `FreshnessFact`.
- **Unchanged recomputation that validates freshness**: creates no new
  candidate; adds an `up-to-date` `FreshnessFact` only.
- **Invalidation**: creates no new candidate; adds a `potentially-outdated`
  `FreshnessFact` only.
- **Host-local deletion**: creates a `TombstoneCandidate` (ordered by deletion
  time) and, if a value was replaced, a `potentially-outdated` `FreshnessFact`;
  the tombstone is the durable deletion evidence.
- **Migration create/delete/invalidate**: creates or removes candidates as a
  first materialization, deletion, or invalidation respectively, all within the
  one migration version advance.
- **Bulk reset add/edit/delete/invalidate/validate**: creates or removes
  candidates per the transition-to-event matrix
  (`incremental-graph-journal-emission.md` § Transition-to-event matrix),
  including tombstones for reset deletions, all within the one reset version
  advance.

Operations that do not create a new candidate: unchanged recomputation,
invalidation, cache-hit pull, export, compaction, and synchronization-only
changes. Operations that only add monotonic evidence: unchanged recomputation
(adds an `up-to-date` fact), invalidation (adds a stale fact). The merge basis
and the exported causal frontier are committed together, so a crash can never
expose new graph state with a stale merge basis, or new merge-basis evidence
with an old graph or frontier coordinate.

```js
/**
 * The properties that this type carries are:
 * - The value is a transport-independent, monotonically increasing logical
 *   version of one (Hostname, HostInstanceId) pair.
 * - It advances exactly when the host originates a durable graph or journal
 *   contribution; it never advances for synchronization-only activity.
 *
 * The proof of those properties is guaranteed by:
 * - `makeInitialHostStateVersion()`: returns version 0 for a freshly
 *   initialized storage instance.
 * - `advanceHostStateVersion(version)`: returns the unique successor version
 *   for a host-originated contribution.
 * - HostStateVersion values are never produced from hashes, repository
 *   revisions, timestamps, or storage identifiers.
 */
class HostStateVersionClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("HostStateVersion cannot be instantiated"); }
}

/** @typedef {HostStateVersionClass} HostStateVersion */
```

Conversion functions:

```js
/**
 * The initial HostStateVersion of a freshly initialized storage instance.
 *
 * @returns {HostStateVersion}
 */
function makeInitialHostStateVersion()

/**
 * Advance a HostStateVersion to its unique successor. Callers invoke this only
 * for a host-originated durable contribution; see the advancement rules.
 *
 * @param {HostStateVersion} version
 * @returns {HostStateVersion}
 */
function advanceHostStateVersion(version)

/**
 * Unsafe cast: wraps a non-negative integer as a HostStateVersion.
 * The function is defined only for non-negative integers that came from the
 * logical version sequence of a (Hostname, HostInstanceId) pair.
 *
 * @param {number} value
 * @returns {HostStateVersion}
 */
function unsafeNumberToHostStateVersion(value)

/**
 * Render a HostStateVersion to its numeric persisted representation.
 *
 * @param {HostStateVersion} version
 * @returns {number}
 */
function hostStateVersionToNumber(version)
```

### Semantics (shared)

- An event's immutable payload is fixed at its first durable commit.
- Copying an event preserves its event ID.
- Reappending an event preserves its event ID.
- Moving an event does not change its encoded `originIndex` or its storage
  instance.
- Two ordinary events created by the same host within the same storage instance
  cannot have the same origin index.
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

## Logical snapshot provenance

### LogicalSnapshotId (nominal)

`LogicalSnapshotId` identifies the complete synchronization-relevant logical
state of one frozen logical snapshot. It is a transport-neutral exact identity:
it is not a repository hash, a wrapper around a transport revision, or a
derivation that depends on how the snapshot was produced or stored.

It is computed deterministically from a canonical encoding of:

- the graph's synchronization-relevant projection;
- the canonical retained merge basis;
- the logical journal view (immutable retained events);
- the causal frontier;
- graph schema version;
- graph-and-journal merge protocol version;
- all other logical metadata that can affect synchronization behavior.

It excludes:

- the `LogicalSnapshotId` field itself;
- physical replica slot names;
- database allocation namespaces;
- local filesystem paths;
- transport metadata;
- repository data;
- active versus inactive designation;
- wall-clock checkpoint time.

The same exact logical snapshot under the same schema and protocol receives the
same `LogicalSnapshotId` regardless of which host computed it, which transport
stored it, whether it was created by local operations or by synchronization, or
the order in which physically equivalent storage records were read. Different
synchronization-relevant states receive different identities. The merge
protocol version is part of the identity: two otherwise identical snapshots
interpreted under different merge protocols do not share an ID.

```js
/**
 * The properties that this type carries are:
 * - The value is the exact, deterministic, transport-neutral identity of one
 *   frozen logical snapshot's synchronization-relevant state.
 * - Identical logical state under the same schema and merge protocol always
 *   yields the same identity; different synchronization-relevant states yield
 *   different identities.
 *
 * The proof of those properties is guaranteed by:
 * - `computeLogicalSnapshotId(...)`: hashes a canonical encoding of the full
 *   synchronization-relevant logical state (see `Canonical digest`); the
 *   encoding is deterministic, so equal logical state yields equal input bytes.
 * - LogicalSnapshotId values are never produced from repository hashes,
 *   transport revisions, timestamps, or storage identifiers.
 */
class LogicalSnapshotIdClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("LogicalSnapshotId cannot be instantiated"); }
}

/** @typedef {LogicalSnapshotIdClass} LogicalSnapshotId */
```

Conversion functions:

```js
/**
 * Unsafe cast: wraps a string as a LogicalSnapshotId.
 * The function is defined only for a replica-snapshot digest produced by
 * `computeLogicalSnapshotId` (64 lowercase hexadecimal characters).
 *
 * @param {string} value
 * @returns {LogicalSnapshotId}
 */
function unsafeStringToLogicalSnapshotId(value)

/**
 * Render a LogicalSnapshotId to its string persisted representation.
 * The representation is the fixed-size digest.
 *
 * @param {LogicalSnapshotId} snapshotId
 * @returns {string}
 */
function logicalSnapshotIdToString(snapshotId)
```

### Logical snapshot identity encoding

`LogicalSnapshotId` is the SHA-256 digest of one normative canonical byte
encoding of the **logical** snapshot state. The encoding is a cross-host
protocol identity: its byte layout is normative, not implementation-defined,
and it is independent of physical journal placement. Compaction and
notification-carrier repositioning never change `LogicalSnapshotId`.

A conforming implementation MUST be able to produce the canonical bytes without
implementation-specific choices.

The canonical-encoding version is bound to the merge protocol: a change to the
canonical encoding requires a new `graphAndJournalMergeProtocolVersion`. There
is no fallback parsing or dual identity format.

#### Primitive encoding

Let `bytes(s)` be the UTF-8 bytes of string `s`. Define:

- `len(s)` = 8-byte big-endian unsigned count of bytes(s).
- `string(s)` = `len(s) || bytes(s)`.
- `u64(n)` = 8-byte big-endian unsigned integer; valid range `[0, 2^64-1]`.
- `bool(b)` = one byte: `0x00` false, `0x01` true.
- `array(items)` = `u64(count) || item_1 || ... || item_count`.
- `map(entries)` = `u64(count) || entry_1 || ... || entry_count`, where entries
  are sorted by the byte lexicographic order of their canonical key encodings.
- `set(items)` = `array` of distinct items sorted by canonical byte encoding.

#### Scalar type tags

A tagged scalar is `tag || payload`:

- `0x01` string: `string(s)`.
- `0x02` boolean: `bool(b)`.
- `0x03` number: 8-byte IEEE-754 binary64 big-endian; `-0` and `+0` both encode
  as `+0`; NaN encodes as the single canonical bit pattern `0x7FF8000000000000`
  and no other NaN pattern is produced.
- `0x04` array: `array(elements)`.
- `0x05` record: `array(entries)` where each entry is `string(key) || value`
  and entries are sorted by UTF-8 key bytes.

#### ConstValue encoding

A `ConstValue` (a `SimpleValue`) encodes as its tagged scalar. `undefined`,
`null`, functions, and symbols are not `SimpleValue` values and have no
encoding.

#### Nominal identifier encodings

- `NodeName`: `string(nodeName)`.
- `NodeKey`: `string(nodeKey)` (the canonical key derived from
  `(nodeName, bindings)`).
- `NodeIdentifier`: `string(nodeIdentifier)`.
- `HostInstanceId`: `string(hostInstanceId)`.

#### Number domain

All numeric values are IEEE-754 binary64 values. Counters and indices encoded
as `u64` MUST be integers within `[0, 2^53-1]`.

#### Logical graph projection encoding

The graph projection is the installed graph state after
`projectGraph(joinedMergeBasis)` (see `incremental-graph-synchronization.md` §
Merge basis). It encodes as a map of sublevel records, each sorted by key:

```text
graphState = map([
    "values"       -> map(nodeKey -> taggedConstValue)
    "freshness"    -> map(nodeKey -> 0x01 | 0x02)   // up-to-date | potentially-outdated
    "timestamps"   -> map(nodeKey -> (createdAtMs: u64, modifiedAtMs: u64))
    "validity"     -> map(nodeKey -> set(nodeKey))  // outgoing validity edges, sorted
    "dependencies" -> map(nodeKey -> set(nodeKey))  // direct inputs, sorted
    "identifiers"  -> map(nodeKey -> nodeIdentifier)  // the identifier lookup
])
```

#### Merge basis encoding

The canonical retained merge basis (see `incremental-graph-synchronization.md`
§ Merge basis) encodes as a map from `candidateId` to the candidate record,
sorted by `candidateId`. Each candidate record encodes its origin coordinate,
semantic key, materialized-or-tombstone discriminant, value and timestamps when
materialized, identifier provenance, exact direct-input candidate IDs, and
freshness/validity evidence, in the field order defined there.

#### Logical journal view encoding

The logical journal view is the set of immutable retained journal events
expressed as complete immutable payloads, sorted by a placement-independent
logical key. Because host event IDs are not content hashes, the payload itself
must be part of the identity:

```text
logicalJournalView = set(
    (action: u64,                  // 0=add 1=edit 2=delete 3=invalidate 4=validate
     nodeIdentifier: string,
     semanticKey: string,
     timeMs: u64,
     creator: string,              // journalCreatorToString tagged form
     eventId: string)
)
```

The set is sorted by the placement-independent tuple `(semanticKey, category,
eventId)`, where `category` is derived from the action (`0`=state for
add/edit/delete, `1`=freshness for invalidate/validate). Two events with the
same `eventId` but different payloads produce different logical-journal-view
bytes and therefore different `LogicalSnapshotId`s. The encoding never includes
`JournalIndex`, `last_journal_index`, established gaps or absences, physical
duplicate occurrences, or carrier positions.

#### Causal frontier encoding

```text
causalFrontier = map(hostname -> (instanceId: string, version: u64))
```

sorted by the UTF-8 bytes of `hostnameToString(hostname)`.

#### Top-level encoding

```text
logicalSnapshotBytes(snapshot) =
    array([
        string("logical-snapshot"),
        u64(1),                    // canonical-encoding version
        string(schemaVersion),
        string(mergeProtocolVersion),
        graphStateBytes,
        mergeBasisBytes,
        logicalJournalViewBytes,
        causalFrontierBytes,
    ])

LogicalSnapshotId = sha256(logicalSnapshotBytes(snapshot))
```

Because the top-level format tag, every field order, every type tag, and every
sort order are normative, two conforming implementations produce identical
bytes for the same logical state and different bytes for any one-field
difference. The encoding contains no transport revision, branch, path, remote,
or repository data. The schema and merge-protocol versions are part of the
identity, so two otherwise identical snapshots interpreted under different
schema or merge-protocol versions receive different IDs.

### EncodedSnapshotDigest (optional, transport-level)

A transport-level value may be defined separately to detect corruption or to
cache exact encoded bytes:

```text
EncodedSnapshotDigest = sha256(exactEncodedSnapshotBytes(snapshot))
```

`exactEncodedSnapshotBytes` MAY include physical journal positions, the
watermark, physical duplicate occurrences, carrier positions, and compaction
layout, encoded however the snapshot encoding or the transport adapter chooses.
`EncodedSnapshotDigest` has no role in causal merging, logical equality, or
journal event identity; it is used only for corruption detection or transport
caching.

### HostStateCoordinate (nominal)

One host's position in a causal frontier is a **host-state coordinate**: the
pair of the storage-instance identity and the host's logical state version
within that instance.

```js
/**
 * The properties that this type carries are:
 * - `instanceId` is the immutable storage-instance identity the coordinate
 *   belongs to.
 * - `version` is the transport-independent logical state version of that host
 *   within that instance.
 *
 * The proof of those properties is guaranteed by:
 * - This typedef cannot enforce the property by construction.
 * - Therefore every function that returns this type is part of the proof.
 * - The current return sites are:
 *   - local storage-instance initialization, which records the host's own
 *     instance and initial version 0;
 *   - `unionCausalFrontiers`, which retains the later coordinate for a hostname
 *     and instance;
 *   - `localExportCausalFrontier`, which advances only the local hostname's
 *     coordinate when the host originated new content.
 */
class HostStateCoordinateClass {
    /** @private @type {undefined} */ __brand;

    /** @readonly @type {HostInstanceId} */
    instanceId;

    /** @readonly @type {HostStateVersion} */
    version;
}

/** @typedef {HostStateCoordinateClass} HostStateCoordinate */
```

Two coordinates of the same `Hostname` and `HostInstanceId` are ordered by
their `HostStateVersion` (`4 < 7`). A coordinate with a different
`HostInstanceId` for the same hostname represents unrelated reinitialization of
that hostname's storage and is an explicit administrative conflict, not a
comparison: the synchronization gate rejects it rather than ordering it.

### Causal frontier (nominal)

`CausalFrontier` is the transport-neutral logical frontier of one logical
snapshot. It is a canonical immutable mapping conceptually equivalent to:

```
Map<Hostname, HostStateCoordinate>
```

For every hostname whose host-originated state the snapshot has incorporated,
the frontier records that hostname's latest accepted `HostStateCoordinate`. The
frontier is persisted as part of `SourceSnapshotProvenance` and is included in
the exact synchronization-relevant state that a `LogicalSnapshotId` identifies:
two snapshots with different frontiers are different exact states and receive
different snapshot identities.

The frontier is the single source of the contributor set of a snapshot. The
contributor set of a logical snapshot is derived from the frontier's hostname
keys; no independent contributor value is maintained, so the two can never
disagree. The frontier summarizes which host contributions are included; it
does not substitute for the merge basis (see `incremental-graph-synchronization.md`
§ Merge basis).

```js
/**
 * The properties that this type carries are:
 * - The value is an immutable mapping from each contributing hostname to the
 *   latest accepted host-state coordinate of that hostname already incorporated
 *   by the snapshot.
 * - Iteration and persisted serialization are in deterministic canonical order:
 *   hostnames sorted by `hostnameToString` using deterministic JavaScript
 *   code-unit ordering.
 *
 * The proof of those properties is guaranteed by:
 * - `makeInitialCausalFrontier(ownHostname, ownInstanceId, ownVersion)`:
 *   constructs the frontier `{ ownHostname: { instanceId, version } }` for a
 *   freshly initialized storage instance.
 * - `localExportCausalFrontier(frontier, ownHostname, ownInstanceId,
 *   ownVersion)`: preserves every remote entry of `frontier` and replaces only
 *   the `ownHostname` entry; the caller supplies the host's current version,
 *   which advances only when the host originated new content.
 * - `unionCausalFrontiers(left, right)`: computes the union of two frontiers,
 *   retaining the later coordinate for any hostname and instance present in
 *   both and rejecting a coordinate whose `HostInstanceId` differs for the same
 *   hostname (an administrative conflict).
 * - No mutation operation is exposed on `CausalFrontier` values.
 */
class CausalFrontierClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("CausalFrontier cannot be instantiated"); }
}

/** @typedef {CausalFrontierClass} CausalFrontier */
```

#### Frontier ordering

For two coordinates of the same hostname and instance, the later
`HostStateVersion` is greater:

```text
{ instanceId: I, version: 4 } < { instanceId: I, version: 7 }
```

because `4 < 7`. A coordinate of the same hostname with a different
`HostInstanceId` is unrelated storage and is an administrative conflict, never a
comparison.

#### Frontier dominance

`frontier A dominates frontier B` when, for every hostname represented by `B`,
`A` contains an equal-or-later accepted coordinate for that hostname (same
`HostInstanceId`, equal-or-later `HostStateVersion`). Dominance is the complete
novelty check: a staged frontier that is dominated by the local frontier
contains no host-originated logical contribution that is new to the local
replica. It is sound only because the merge is a closed join over the persisted
merge basis (see `incremental-graph-synchronization.md` § Logical join and §
Merge basis).

#### Frontier functions

```js
/**
 * Construct the causal frontier of a freshly initialized storage instance.
 * The frontier contains exactly `{ ownHostname: { instanceId: ownInstanceId,
 * version: ownVersion } }`.
 *
 * @param {Hostname} ownHostname
 * @param {HostInstanceId} ownInstanceId
 * @param {HostStateVersion} ownVersion
 * @returns {CausalFrontier}
 */
function makeInitialCausalFrontier(ownHostname, ownInstanceId, ownVersion)

/**
 * Derive the causal frontier of an exported logical snapshot taken after
 * ordinary local activity. Every remote entry of `frontier` is preserved
 * exactly; only the `ownHostname` entry is replaced with the local host's
 * current instance (`ownInstanceId`) and version (`ownVersion`). The caller
 * passes an advanced `ownVersion` only when the host actually originated new
 * logical graph or journal state since the prior export; a frontier-only
 * acknowledgement must not advance the local coordinate. The local
 * `HostInstanceId` never changes after initialization.
 *
 * @param {CausalFrontier} frontier
 * @param {Hostname} ownHostname
 * @param {HostInstanceId} ownInstanceId
 * @param {HostStateVersion} ownVersion
 * @returns {CausalFrontier}
 */
function localExportCausalFrontier(frontier, ownHostname, ownInstanceId, ownVersion)

/**
 * Union two causal frontiers. For a hostname present in only one frontier, its
 * entry is retained. For a hostname present in both:
 * - equal coordinates are retained;
 * - when the two coordinates have the same `HostInstanceId`, the later
 *   `HostStateVersion` is retained;
 * - when the two coordinates have different `HostInstanceId` values for the
 *   same hostname, the union rejects the input as an administrative conflict
 *   rather than guessing a winner.
 *
 * The union is commutative: `unionCausalFrontiers(left, right)` and
 * `unionCausalFrontiers(right, left)` produce the same frontier or the same
 * rejection.
 *
 * @param {CausalFrontier} left
 * @param {CausalFrontier} right
 * @returns {CausalFrontier}
 */
function unionCausalFrontiers(left, right)

/**
 * Return the host-state coordinate recorded for a hostname, or `undefined` when
 * the frontier does not contain the hostname.
 *
 * @param {CausalFrontier} frontier
 * @param {Hostname} hostname
 * @returns {HostStateCoordinate | undefined}
 */
function causalFrontierGet(frontier, hostname)

/**
 * Return the hostnames of a frontier in canonical order. The contributor set of
 * a snapshot is derived from this set:
 * `makeSync(causalFrontierHostnames(frontier))`.
 *
 * @param {CausalFrontier} frontier
 * @returns {ReadonlyArray<Hostname>}
 */
function causalFrontierHostnames(frontier)

/**
 * Render a CausalFrontier to its deterministic string persisted representation,
 * used for storage, integrity comparison, and hashing into snapshot identities.
 * The representation is a canonical JSON array of `[hostname, instanceId,
 * version]` tuples sorted by `hostnameToString` using deterministic JavaScript
 * code-unit ordering.
 *
 * @param {CausalFrontier} frontier
 * @returns {string}
 */
function causalFrontierToString(frontier)

/**
 * True when `local` dominates `staged`: for every hostname represented by
 * `staged`, `local` contains an equal-or-later accepted coordinate (same
 * HostInstanceId, equal-or-later HostStateVersion). This is the complete
 * novelty check for the synchronization gate.
 *
 * @param {CausalFrontier} local
 * @param {CausalFrontier} staged
 * @returns {boolean}
 */
function dominatesCausalFrontier(local, staged)
```

### SourceSnapshotProvenance

Each logical source snapshot used by synchronization carries provenance
equivalent to:

```js
/**
 * @typedef {object} SourceSnapshotProvenance
 * @property {LogicalSnapshotId} id
 * @property {CausalFrontier} causalFrontier
 * @property {string} graphAndJournalMergeProtocolVersion
 * @property {Version} schemaVersion
 */
```

For an exported logical snapshot staged from a host:

```text
id                         = LogicalSnapshotId of the exact logical snapshot
causalFrontier             = the host's causal frontier at export: it maps the
                             hostname to its own current coordinate (instance and
                             logical version) and preserves every remote
                             coordinate the host had already incorporated
graphAndJournalMergeProtocolVersion = the currently advertised protocol version
schemaVersion              = the source's schema version
```

For a merge result:

```text
id                         = LogicalSnapshotId of the merged exact logical state
causalFrontier             = unionCausalFrontiers(left.causalFrontier,
                             right.causalFrontier)
graphAndJournalMergeProtocolVersion = preserved from the inputs
schemaVersion              = preserved from the inputs
```

The frontier union rejects a merge whose two inputs record unresolvable
coordinates for a common hostname — in particular, a coordinate whose
`HostInstanceId` differs for the same hostname, which is an administrative
conflict. This is the rejection rule for a regressed or conflicting host
coordinate during normal synchronization; see
`incremental-graph-journal-sync.md` § Causal frontier and the synchronization
gate.

The protocol and schema versions are persisted as explicit compatibility
metadata with every synchronization source, stored separately even though they
are also hashed into the `LogicalSnapshotId`. Pairwise merge rejects inputs with
mismatching protocol or schema versions before graph or journal reconciliation.

A `SourceSnapshotProvenance` describes one exact synchronization-relevant
source state. Any ordinary graph or journal mutation (for example a `pull` or
`invalidate`) makes existing exact-snapshot provenance inapplicable to the
resulting mutable replica: the replica is no longer the exact state the
provenance identifies. Provenance for a mutable replica is established only by
freezing/exporting that replica into an exact logical snapshot and deriving
fresh provenance for the exact frozen state.

At the beginning of synchronization, while graph activity is excluded, the
exact local source is frozen/exported and fresh provenance is derived for that
precise local logical snapshot; this provenance is used as the local source's
provenance for the first per-host merge.

Each derived merge output receives persisted provenance before it can become
the next local source.

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
causal frontier and is never maintained as an independent value: for a
snapshot whose frontier is `F`, the contributor set is
`makeSync(causalFrontierHostnames(F))` (see `Causal frontier`).
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

For a sync-derived event, `creator = makeSync(causalFrontierHostnames(joined
frontier))`: the set of contributing source hosts represented by the merged
frontier, canonically ordered. It does not identify one host as the actor and
is not limited to the hosts involved in the latest exchange.

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

## Journal namespace

The journal of one storage instance has a single monotonic index namespace. The
established-position invariants and watermark monotonicity (REQ-JT-11 through
REQ-JT-20) hold for the entire storage instance; there is no reset-specific
journal lineage or discontinuity. Reset is an ordinary bulk graph operation
that preserves every established journal position and absence, appends only
above the current watermark, and never decreases `last_journal_index` (see
`incremental-graph-journal-emission.md` § Bulk reset).

### Cursor domain continuity

The `JournalCursorDomain` belongs to one running graph service/session and is
not rotated by a reset. A successful reset preserves the existing cursor
domain and keeps existing `PossibleNodeChange` cursors valid; a cursor obtained
before reset observes reset-generated events afterward. Migration cutover may
publish a fresh cursor domain as a schema-change lifecycle step (see
`incremental-graph-journal-migrations.md`).

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
the same JavaScript process. A reset preserves the existing domain and keeps
existing tokens valid (see `Journal namespace`); a successful migration cutover
may publish a fresh domain as a schema-change lifecycle step (see
`incremental-graph-journal-migrations.md`).

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
  synchronization preserves the cursor domain; a reset is an ordinary bulk
  graph operation that also preserves the domain and keeps existing tokens
  valid (see `Journal namespace`).
- A `PossibleNodeChange` cursor is **not portable** to another process or host
  without additional serialization mechanisms that are not specified by this
  specification.

Persistence of these tokens across process restarts, synchronization boundaries
that involve heterogeneous hosts without the notification protocol, or
migration/schema boundaries, and the corresponding long-lived validity
guarantees, are out of scope for this specification and deferred to a future
computor/cursor-persistence specification.

A successful migration cutover may publish a fresh cursor domain and reject
tokens registered in the old domain; a failed migration preserves the old
domain (see `incremental-graph-journal-migrations.md`).

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
`eventId` derives from the merge protocol version, the action, the key, and the
canonical derived time of the joined journal evidence.

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

### E6 — LogicalSnapshotId includes the schema and protocol versions

Two exact logical snapshots `S` and `S'` that differ only in schema version
receive different `LogicalSnapshotId`s, because `versionToString(schemaVersion)`
differs. Two snapshots that differ only in
`graphAndJournalMergeProtocolVersion` also receive different IDs: otherwise
identical state interpreted under two merge protocols must not share an
identity.

### E6a — LogicalSnapshotId includes the causal frontier

Host A exports two logical snapshots with the same graph and journal state but
different causal frontiers:

```
F1 = { A: { LA, 1 } }
F2 = { A: { LA, 1 }, B: { LB, 1 } }
```

The two snapshot IDs differ because
`causalFrontierToString(F1) ≠ causalFrontierToString(F2)`. Consequently a merge
using one snapshot cannot receive the same sync event ID as a merge using the
other: the snapshot IDs embedded in the sync event ID differ, so the creator
(derived from the frontier) can never be paired with the wrong event identity.

### E7 — Frontier ordering and administrative conflict

Host H has coordinates `{ I, 4 }` and `{ I, 7 }` in the same storage instance
`I`.

- Frontier `F1 = { H: { I, 4 } }` and `F2 = { H: { I, 7 } }` union to
  `{ H: { I, 7 } }`: same instance, and `7 > 4`, so the later coordinate is
  retained.
- Frontier `F1 = { H: { I, 4 } }` and `F3 = { H: { I, 4 } }` union to
  `{ H: { I, 4 } }`: equal coordinates are retained.
- Frontier `F1 = { H: { I, 4 } }` and `F4 = { H: { I', 0 } }`, where `I'` is a
  different storage-instance identity for the same hostname H, represents
  unrelated reinitialization of H's storage; the union rejects it as an
  administrative conflict rather than ordering or guessing a winner.

### E8 — Contributor set derives from the frontier

A snapshot whose frontier is `{ A: {IA, 1}, B: {IB, 2}, C: {IC, 1} }` has
contributor set `makeSync(causalFrontierHostnames(frontier)) =
Sync{A, B, C}`. The contributor set is never stored independently, so it cannot
disagree with the frontier.

### E9 — Frontier coordinate resolution rules

For a staged coordinate `{ Is, vs }` compared against a frontier coordinate
`{ If, vf }` for the same hostname:

- same instance (`Is === If`) and equal version (`vs === vf`): already
  incorporated, complete no-op;
- same instance and `vs > vf`: later logical state, normal advancement, merge;
- same instance and `vs < vf`: regression, reject;
- different instance (`Is !== If`): unrelated storage reinitialization,
  administrative conflict, reject.

### E10 — Host event identity uses the storage-instance identity

Host A in storage instance `IA` emits an event at index 21:

```
eventId = JSON.stringify(["host", "A", hostInstanceIdToString(IA), 21])
```

A later unrelated reinitialization of host A creates a new storage instance
`IA2`; events there use

```
eventId = JSON.stringify(["host", "A", hostInstanceIdToString(IA2), 21])
```

The two event IDs differ, so synchronization cannot confuse the two payloads.
The same instance value also appears in the frontier coordinate
`{ A: { IA2, 0 } }`, so host-event identity and frontier coordinates share one
canonical instance representation.

### Canonical-encoding test vectors

### C1 — Minimal empty or fresh replica

A fresh storage instance with no materialized nodes, no journal events, frontier
`{ A: { I, 0 } }`, and an empty merge basis encodes to exactly the bytes of
`array(["logical-snapshot", u64(1), schemaVersion, protocolVersion, emptyGraph,
emptyBasis, emptyJournalView, frontierBytes])`. Its `LogicalSnapshotId` is the
SHA-256 of those bytes.

### C2 — One materialized node

Adding one materialized node with a value, freshness, timestamps, an
identifier, and a merge-basis candidate changes exactly the `values`,
`freshness`, `timestamps`, `identifiers`, and merge-basis maps; the canonical
bytes differ from C1 in exactly those positions.

### C3 — Nested ConstValue data

A node value `{ record: { deep: [1, "x", true] } }` encodes as a nested tagged
record whose nested arrays and records use the same tags and sort order at every
depth.

### C4 — Map entries in different physical orders

Two implementations that insert the same map entries in different physical
orders produce identical canonical bytes, because every map is sorted by key
before encoding.

### C5 — Logical journal view is placement-independent

Two journals with the same retained logical events placed at different physical
indices, or with different compaction-removed absences, produce identical
logical-journal-view bytes and therefore the same `LogicalSnapshotId`.
`JournalIndex`, `last_journal_index`, established gaps, and physical duplicate
occurrences are excluded from the logical identity.

### C6 — Causal frontier with several hosts

A frontier `{ A: { I1, 1 }, B: { I2, 2 }, C: { I3, 0 } }` encodes as a map
sorted by hostname; a different insertion order produces the same bytes.

### C7 — Compaction and carrier repositioning do not change the identity

Two snapshots that differ only in compacted physical layout or notification-
carrier positions produce the same `LogicalSnapshotId`; they may produce
different `EncodedSnapshotDigest` values, which is their only transport-level
role.

### C8 — Independent implementations produce identical bytes and digest

Two independent implementations of the canonical encoding, given the same
logical snapshot, produce the same canonical bytes and therefore the same
`LogicalSnapshotId`.

### C9 — One-field changes produce different bytes and IDs

Changing any single logical field — one value, one timestamp, one freshness, one
retained journal event, one merge-basis candidate, one frontier coordinate —
changes the canonical bytes and therefore the `LogicalSnapshotId`.

### C10 — Different schema or merge-protocol versions produce different IDs

Two otherwise identical snapshots that differ only in `schemaVersion` or only in
`graphAndJournalMergeProtocolVersion` produce different canonical bytes and
different `LogicalSnapshotId`s.

### C11 — Same event ID and key, different timestamp

Two journal views that retain an event with the same `eventId` and `semanticKey`
but different `timeMs` produce different logical-journal-view bytes and
different `LogicalSnapshotId`s.

### C12 — Same event ID and key, different identifier

Two journal views that retain an event with the same `eventId` and `semanticKey`
but different `nodeIdentifier` produce different bytes and IDs.

### C13 — Same event ID and key, `add` versus `edit`

Two journal views that retain an event with the same `eventId` and `semanticKey`
but actions `add` and `edit` produce different bytes and IDs (the action and the
derived category differ).

### C14 — Same event ID and key, `edit` versus `delete`

Two journal views that retain an event with the same `eventId` and `semanticKey`
but actions `edit` and `delete` produce different bytes and IDs.

### C15 — Same event ID, different creator payload

Two journal views that retain an event with the same `eventId` but different
canonical creator encodings produce different bytes and IDs. A payload that
claims a `Sync` creator for a host-originated action is malformed and MUST be
rejected before its `LogicalSnapshotId` is accepted. Two payload-distinct
sources can therefore never generate the same downstream sync event identity.

---

## Out of scope

This specification does not cover:

- Persistence/serialization of public journal tokens.
- Long-lived cursor validity policies.
- Checkpoint/lease-based compaction safety.
