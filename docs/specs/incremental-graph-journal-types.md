# IncrementalGraph Journal Types

## Purpose

This document defines the core types used by the IncrementalGraph journal: journal entries, timestamps, host identifiers, journal indices, and the public `PossibleNodeChange` and `BaselinePossibleNodeChange` tokens.

All journal types follow the existing nominal/opaque typing discipline used by `NodeIdentifier`, `NodeKeyString`, `NodeName`, and related IncrementalGraph types. See `backend/src/generators/incremental_graph/database/types.js` and `docs/specs/keys-design.md` for the established patterns.

---

## JournalEventId (internal)

### Purpose

`JournalEventId` provides stable, immutable identity for one logical journal event. Logical journal events may be emitted by ordinary graph operations, migration, or synchronization (for `invalidate` and `delete`).

The ID is created during the event's first durable commit:

```js
const eventId = JSON.stringify([
    hostnameToString(creator),
    journalIndexToNumber(originIndex),
]);
```

Use exactly the fixed-order `[creator, originIndex]` tuple passed to
`JSON.stringify`. No version tag, custom serialization format, multiple
event-ID variants, or optional event-ID fields.

```js
/**
 * Stable identity of one logical journal event.
 *
 * @typedef {string} JournalEventId
 */
```

### Semantics

- `creator` is the host that originally emitted the event.
- `originIndex` is the first physical journal position assigned to the event.
- The event ID is assigned atomically with that first position.
- Copying an event preserves its event ID.
- Reappending an event preserves its event ID.
- Moving an event does not change the encoded `originIndex`.
- Two events created by the same host cannot have the same origin index.
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
    hostnameToString(entry.creator),
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

## JournalEntry (internal)

### Shape

```js
/**
 * A single journal entry recording a graph change.
 * This is an internal structural type, NOT exposed through the public
 * `graph.possibleMaybeChanges` API.
 *
 * @typedef {object} JournalEntry
 * @property {JournalAction} action - The kind of change recorded.
 * @property {NodeIdentifier} id - The node identifier of the affected node.
 * @property {NodeKey} key - The semantic node key at the time of the change.
 * @property {UnixTimestamp} time - When the change was recorded.
 * @property {Hostname} creator - The host that originally emitted the logical event.
 * @property {JournalEventId} eventId - Stable identity of this event.
 */
```

The `*Class` declarations throughout this document (e.g. `UnixTimestampClass`, `JournalIndexClass`, `HostnameClass`, `PossibleNodeChangeClass`, `BaselinePossibleNodeChangeClass`) are nominal JSDoc brands. They do not imply that values are constructed with these classes at runtime. As with `NodeIdentifier`, the runtime representation may be a plain value/object that is treated as the branded type only through controlled casts.

A `JournalEntry` is an internal type. Ordinary users of `graph.possibleMaybeChanges` do not receive `JournalEntry` values. The public API surface uses `PossibleNodeChange`.

### Terminology

```
logical event       = immutable historical event identified by eventId
physical occurrence = one storage position containing that event
notification        = exposure of an event after a cursor
```

Moving or copying an event creates no new logical event. A synchronization-generated
`invalidate` or `delete` is a new logical event because an actual corresponding
local transition occurred.

### JournalAction

```js
/**
 * The kind of change recorded in a journal entry.
 * @typedef {'add' | 'edit' | 'delete' | 'invalidate' | 'validate'} JournalAction
 */
```

Each action describes the historical origin transition. The event proves that
transition occurred atomically with the graph change.

- `'add'` — the node became materialized for the first time.
- `'edit'` — the node's stored semantic value changed materially.
- `'delete'` — an actual deletion or unmaterialization transition occurred.
  Emitted by `storage.delete`, another actual deletion operation, or
  synchronization (when final graph unmaterializes a previously materialized
  local node).
- `'invalidate'` — freshness transitioned from `up-to-date` to
  `potentially-outdated`.
- `'validate'` — successful recomputation transitioned an already materialized
  node from `potentially-outdated` to `up-to-date`.

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

**Freshness events are journal history, not current graph state.** A retained
`validate` or `invalidate` entry records a freshness transition that occurred
at the time of emission. The current graph freshness may differ — a later
synchronization, invalidation, or recomputation may have changed it. Consumers
MUST re-read the current graph state (via `getFreshness`) rather than treating
journal freshness events as authoritative current-state indicators. The
canonical freshness history selected by synchronization is journal history; the
graph synchronization rules determine final graph freshness.

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

REQ-JT-03: Implementations SHOULD record journal timestamps using the local system clock at the time of emission. Host clocks are not assumed to be synchronized across hosts.

Journal timestamps provide human-readable event ordering for consumers. Graph synchronization uses graph `modifiedAt` timestamps, not journal timestamps, for conflict resolution.

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
 * Caller MUST ensure value is a finite, non-negative integer
 * representing milliseconds since the Unix epoch.
 * Implementations SHOULD validate this in debug builds.
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
 * Caller MUST ensure value is a non-empty string that uniquely
 * identifies this host in the synchronization mesh and is stable
 * across restarts.
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
 * Caller MUST ensure value is a positive integer representing
 * a real journal position.
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
- **Compaction**: may delete entries while holding `closeGarden` (see `incremental-graph-journal-compaction.md`).
- **Synchronization poisoning**: may delete divergent entries while holding `closeGarden` (see `incremental-graph-journal-sync.md`).
- **Synchronization absence propagation**: may remove an entry when a synchronized host has established absence at the same index (see `incremental-graph-journal-sync.md`).

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

REQ-JT-20: Gaps in the journal index sequence are allowed. They may be caused by compaction, sync poisoning, or structural maintenance. Gaps caused by failed transactions are NOT possible under the commit-time allocation model, because index allocation occurs only during the durable commit, which either succeeds or fails atomically. Once a later watermark publishes a prefix containing a gap, ordinary appenders MUST NEVER fill that gap.

---

## Private cursor state (internal)

The journal module owns private cursor state associating a public token with
its internal journal index. This is NOT exposed through the public type.

```js
/**
 * @typedef {object} CursorState
 * @property {IncrementalGraph} ownerGraph
 * @property {JournalIndex} index
 */
```

The state is stored in a module-private `WeakMap<PossibleNodeChange, CursorState>`.
Equivalent module-private storage is acceptable.

- A token is registered only when returned by `possibleMaybeChanges`.
- `since` lookup verifies that the token is known.
- Lookup verifies that it belongs to the receiving graph instance.
- Unknown, forged, or foreign tokens are rejected by one explicit error.

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
snapshot so later caller mutation cannot falsify the historical fields.

```js
/**
 * Public projection of a journal entry.
 *
 * The raw journal index is stored in a module-private WeakMap, not
 * as an own property, enumerable property, or symbol property. It is
 * not inspectable through the token.
 *
 * @typedef {object} PossibleNodeChange
 * @property {NodeName} nodeName
 * @property {Array<ConstValue>} bindings
 * @property {JournalAction} action
 * @property {UnixTimestamp} time
 */
```

**This PR specifies only same-process, in-memory journal token usage.** A
`PossibleNodeChange` returned during a process session is valid as `since` for
subsequent calls within that same session. Specifically, within the same
process:

- A `PossibleNodeChange` cursor remains valid across **physical compaction**.
  The private journal index persists even if its backing entry is physically
  deleted. A later query scans strictly after that index and tolerates absent
  entries (see `incremental-graph-journal-compaction.md`).
- A `PossibleNodeChange` cursor remains valid across **structural
  synchronization and active-replica cutover** in the same process. The
  notification coverage rules in `incremental-graph-journal-sync.md` ensure
  that any change observable to the cursor is reported through repositioned
  canonical events.
- A `PossibleNodeChange` cursor is **not portable** to another process or host
  without additional serialization mechanisms that are not specified by this PR.

Persistence of these tokens across process restarts, synchronization boundaries
that involve heterogeneous hosts without the notification protocol, or
migration/schema boundaries, and the corresponding long-lived validity
guarantees, are out of scope for this PR and deferred to a future
computor/cursor-persistence specification.

```js
class PossibleNodeChangeClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("PossibleNodeChange cannot be instantiated externally"); }

    /** @type {NodeName} */
    nodeName;

    /** @type {Array<ConstValue>} */
    bindings;

    /** @type {JournalAction} */
    action;

    /** @type {UnixTimestamp} */
    time;
}

/**
 * A real journal-backed possible node change.
 * Returned by `graph.possibleMaybeChanges(...)`.
 *
 * The properties that this type carries are:
 * - The value is derived from a committed journal entry.
 * - `nodeName`, `bindings`, `action`, and `time` accurately describe the
 *   recorded change.
 * - The value may be passed as `since` to `graph.possibleMaybeChanges`.
 *
 * The proof of those properties is guaranteed by:
 * - This type can only be introduced through this operation:
 *   - `graph.possibleMaybeChanges(...)`: satisfies the property because it
 *     only returns PossibleNodeChange values derived from committed journal
 *     entries, and each returned value carries the public fields of that entry.
 *
 * @typedef {PossibleNodeChangeClass} PossibleNodeChange
 */
```

REQ-JT-21: `PossibleNodeChange` MUST expose `nodeName`, `bindings`, `action`, and `time` as public fields. Private journal fields (`id`, `key`, `creator`, `eventId`, `index`) are not part of the public nominal type. Callers MUST NOT depend on fields beyond those listed in the public `PossibleNodeChange` type.

REQ-JT-22: A `PossibleNodeChange` returned by `graph.possibleMaybeChanges` MUST have `nodeName` and `bindings` that correspond to a valid node key in the graph at the time the change was recorded.

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

## Journal-internal since-position encoding

Internally, the journal module converts the public `since` value into a
private cursor position using the module-private `WeakMap<PossibleNodeChange, CursorState>`:

```js
/**
 * Journal module only.
 *
 * @typedef {{ kind: 'baseline' } | { kind: 'journal', index: JournalIndex, ownerGraph: IncrementalGraph }} PrivateSincePosition
 */
```

If `since` is `BaselinePossibleNodeChange`, this yields `{ kind: "baseline" }`
— a position less than any real journal index.

If `since` is `PossibleNodeChange`, the module looks up the token in the
private `WeakMap`:

- If the token is unknown or forged, throw a single explicit error.
- If the token belongs to a different graph instance, throw the same error.
- Otherwise yield `{ kind: "journal", index, ownerGraph }`, scanning strictly
  after that `index`.

---

## Nominal boundary summary

Both `PossibleNodeChange` and `BaselinePossibleNodeChange` are nominal public
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


Journal modules maintain internal widening/casting functions that follow the same pattern as `unsafeStringToNodeIdentifier`. Public callers MUST NOT access or depend on the widened representation.

---

## Out of scope

This PR does not specify:

- Persistence/serialization of public journal tokens.
- Long-lived cursor validity policies.
- Checkpoint/lease-based compaction safety.
- Type guards for storage/deserialization boundaries.
