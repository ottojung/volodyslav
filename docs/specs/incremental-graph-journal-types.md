# IncrementalGraph Journal Types

## Purpose

This document defines the core types used by the IncrementalGraph journal: journal entries, timestamps, host identifiers, journal indices, and the public `PossibleNodeChange` and `BaselinePossibleNodeChange` tokens.

All journal types follow the existing nominal/opaque typing discipline used by `NodeIdentifier`, `NodeKeyString`, `NodeName`, and related IncrementalGraph types. See `backend/src/generators/incremental_graph/database/types.js` and `docs/specs/keys-design.md` for the established patterns.

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
 * @property {Hostname} creator - The host that recorded the change.
 */
```

The `*Class` declarations throughout this document (e.g. `UnixTimestampClass`, `JournalIndexClass`, `HostnameClass`, `PossibleNodeChangeClass`, `BaselinePossibleNodeChangeClass`) are nominal JSDoc brands. They do not imply that values are constructed with these classes at runtime. As with `NodeIdentifier`, the runtime representation may be a plain value/object that is treated as the branded type only through controlled casts.

A `JournalEntry` is an internal type. Ordinary users of `graph.possibleMaybeChanges` do not receive `JournalEntry` values. The public API surface uses `PossibleNodeChange`.

### JournalAction

```js
/**
 * The kind of change recorded in a journal entry.
 * @typedef {'add' | 'edit' | 'delete' | 'invalidate'} JournalAction
 */
```

- `'add'` — a node became materialized for the first time.
- `'edit'` — a node's stored value materially changed.
- `'delete'` — a node was removed or superseded (by synchronization, conflict resolution, or migration deletion).
- `'invalidate'` — a node's freshness changed from `up-to-date` to `potentially-outdated`.

---

## UnixTimestamp

`UnixTimestamp` is an integer count of milliseconds since the Unix epoch (January 1, 1970, 00:00:00 UTC). This is consistent with JavaScript's `Date.now()` and `Date.prototype.getTime()`.

REQ-JT-01: The unit of `UnixTimestamp` MUST be integer milliseconds. Fractional timestamps MUST NOT be used.

REQ-JT-02: The persisted representation of `UnixTimestamp` is a numeric integer (JavaScript `number`).

REQ-JT-03: Implementations SHOULD record journal timestamps using the local system clock at the time of emission. Host clocks are not assumed to be synchronized across hosts.

These timestamps are used by the v1 sync conflict policy. A particular host's wall clock may be incorrect, but this is the best available signal for conflict ordering — the system trusts hosts and does not rely on external time authorities. See `incremental-graph-journal-sync.md` §Conflict resolution.

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

REQ-JT-05: Two distinct hosts in the synchronization mesh MUST have different `Hostname` values. If two hosts accidentally share a hostname, tie-breaking falls through to the next deterministic rule (see `incremental-graph-journal-sync.md`).

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

### Journal index storage

The next journal index to allocate is maintained in volatile state (analogous to the `_nextNodeIndex` pattern in identifier allocation). The last committed journal index watermark is stored in global metadata:

```
rendered/r/global/last_journal_index
```

REQ-JT-11: `last_journal_index` MUST NOT decrease. A fresh replica starts with `last_journal_index = 0`. The first committed journal entry uses index `1`, mirroring the `last_node_index` convention.

REQ-JT-12: After synchronization, `last_journal_index` MUST be at least the greatest index that is present or known-absent due to synchronized journal state. A known-absent index still contributes to the watermark so that future local allocations do not reuse or overwrite an index that another synchronized host has already allocated, compacted, or poisoned.

---

## PrivatePossibleNodeChange (internal)

### Purpose

The journal implementation internally needs a wider representation that pairs a `JournalEntry` with its storage `JournalIndex`. This internal type is NOT exported as public API. Only journal modules may construct, inspect, or cast through this type.

```js
/**
 * Private journal-module-only representation.
 * This is not exported as public API.
 *
 * Contains both:
 *   - public projection fields (nodeName, bindings, action, time)
 *     that are exposed through PossibleNodeChange,
 *   - private journal fields (id, key, creator, index) that
 *     are hidden from public callers.
 *
 * nodeName and bindings are derived from `key` when the entry
 * is constructed.  They remain on the runtime object so that
 * `privatePossibleNodeChangeToPossibleNodeChange` can perform a
 * nominal narrowing without constructing a new object.
 *
 * @typedef {object} PrivatePossibleNodeChange
 * @property {JournalAction} action
 * @property {NodeIdentifier} id
 * @property {NodeKey} key
 * @property {UnixTimestamp} time
 * @property {Hostname} creator
 * @property {JournalIndex} index
 * @property {NodeName} nodeName
 * @property {Array<ConstValue>} bindings
 */
```

`PrivatePossibleNodeChange` extends `JournalEntry` with the `index`, `nodeName`, and `bindings` fields. The `nodeName` and `bindings` are the public projection fields derived from `JournalEntry.key`; they are stored on the same runtime value so that `privatePossibleNodeChangeToPossibleNodeChange` is a non-lossy nominal narrowing — NOT a fresh projection or a field-subsetting operation.

### Conversion functions (journal modules only)

```js
/**
 * Journal module only.
 * Narrowing cast from the private representation to the public nominal token.
 *
 * This is a nominal narrowing of the SAME runtime value. It MUST NOT
 * construct a new object, pick a subset of fields, or discard the
 * private fields (`id`, `key`, `creator`, `index`). The returned
 * `PossibleNodeChange` retains all private journal-module fields at
 * runtime even though the public type only exposes `nodeName`,
 * `bindings`, `action`, and `time`.
 *
 * @param {PrivatePossibleNodeChange} change
 * @returns {PossibleNodeChange}
 */
function privatePossibleNodeChangeToPossibleNodeChange(change)

/**
 * Journal module only.
 * Unsafe widening from public nominal token back to the private
 * representation. This is valid only because the value was originally
 * created from a `PrivatePossibleNodeChange` by the narrowing operation
 * above.
 *
 * This is allowed only inside the journal implementation.
 *
 * @param {PossibleNodeChange} change
 * @returns {PrivatePossibleNodeChange}
 */
function possibleNodeChangeToPrivatePossibleNodeChangeUnsafe(change)
```

The important properties:

- `PossibleNodeChange` is a nominal type, not a fresh structural object.
- `privatePossibleNodeChangeToPossibleNodeChange` performs a nominal narrowing of the same runtime value. It MUST NOT discard the private fields required for later widening.
- `possibleNodeChangeToPrivatePossibleNodeChangeUnsafe` reverses that narrowing. It is valid only because values yielded by `graph.possibleMaybeChanges` were originally created from `PrivatePossibleNodeChange`.
- Ordinary public callers MUST NOT inspect or depend on `JournalIndex`, `NodeIdentifier`, or `Hostname`. These fields exist at runtime but are inaccessible through the public type.

The internal widening follows the same pattern as `unsafeStringToNodeIdentifier` in the database types: an unsafe cast that journal modules control at their module boundary. Public callers never see the widened representation.

---

## PossibleNodeChange (public)

### Purpose

`PossibleNodeChange` is the public unit of journal observation. It is yielded by `graph.possibleMaybeChanges` and may be passed back as the `since` argument to a later call in the same process session. Every `PossibleNodeChange` is derived from a committed journal entry.

**This PR specifies only same-process, in-memory journal token usage.** A `PossibleNodeChange` yielded during a process session is valid as `since` for subsequent calls within that same session. Persistence of these tokens across process restarts, synchronization boundaries, or migration boundaries, and the corresponding long-lived validity guarantees, are out of scope for this PR and deferred to a future computor/cursor-persistence specification.

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
 * Yielded by `graph.possibleMaybeChanges(...)`.
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
 *     only yields PossibleNodeChange values derived from committed journal
 *     entries, and each yielded value carries the public fields of that entry.
 *
 * @typedef {PossibleNodeChangeClass} PossibleNodeChange
 */
```

REQ-JT-13: `PossibleNodeChange` MUST expose `nodeName`, `bindings`, `action`, and `time` as public fields. Private journal fields (`id`, `key`, `creator`, `index`) are not part of the public nominal type. Callers MUST NOT depend on fields beyond those listed in the public `PossibleNodeChange` type.

REQ-JT-14: A `PossibleNodeChange` returned by `graph.possibleMaybeChanges` MUST have `nodeName` and `bindings` that correspond to a valid node key in the graph at the time the change was recorded.

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

Internally, the journal module converts the public `since` value into a private cursor position:

```js
/**
 * Journal module only.
 *
 * @typedef {{ kind: 'baseline' } | { kind: 'journal', change: PrivatePossibleNodeChange }} PrivateSincePosition
 */

/**
 * Journal module only.
 * @param {PossibleNodeChange | BaselinePossibleNodeChange} since
 * @returns {PrivateSincePosition}
 */
function sinceToPrivateSincePosition(since)
```

If `since` is `BaselinePossibleNodeChange`, this yields `{ kind: "baseline" }` — a position less than any real journal index.

If `since` is `PossibleNodeChange`, this widens it to `PrivatePossibleNodeChange` and yields `{ kind: "journal", change: privateChange }`, scanning strictly after its `index`.

---

## Nominal boundary summary

Both `PossibleNodeChange` and `BaselinePossibleNodeChange` are nominal public journal tokens with different public semantics:

- `PossibleNodeChange`: journal-backed change token with meaningful public fields (`nodeName`, `bindings`, `action`, `time`). Every `PossibleNodeChange` is derived from a committed journal entry via `privatePossibleNodeChangeToPossibleNodeChange`.

- `BaselinePossibleNodeChange`: a position less than any real journal index. It is not derived from a journal entry.

The journal implementation internally uses `PrivatePossibleNodeChange` (which includes the `JournalIndex`) and `PrivateSincePosition`. The conversion directions are:

| Direction | Function | Permitted in |
|-----------|----------|--------------|
| Private → Public | `privatePossibleNodeChangeToPossibleNodeChange` | Journal modules only |
| Public → Private | `possibleNodeChangeToPrivatePossibleNodeChangeUnsafe` | Journal modules only |
| since → PrivateSincePosition | `sinceToPrivateSincePosition` | Journal modules only |
| Public | `graph.possibleMaybeChanges` yields | Public API |

```
┌──────────────────────────────────────────────┐
│              Public API boundary             │
│                                              │
│  graph.possibleMaybeChanges({                │
│      since,                                  │
│      to,                                     │
│  }): AsyncIterableIterator<PossibleNodeChange>       │
│                                              │
│  baselinePossibleNodeChange():               │
│      BaselinePossibleNodeChange              │
│                                              │
 │  Public fields (PossibleNodeChange):         │
 │      nodeName, bindings, action, time        │
 │  Not part of public API contract:            │
 │      id, key, creator, index                 │
└──────────────────────────────────────────────┘
```

`privatePossibleNodeChangeToPossibleNodeChange` is a nominal narrowing of the same runtime value. It MUST NOT discard the private fields (`id`, `key`, `creator`, `index`) required for later journal-module widening. The runtime value retains both the public projection fields (`nodeName`, `bindings`, `action`, `time`) and the private journal-module fields.

`possibleNodeChangeToPrivatePossibleNodeChangeUnsafe` reverses this narrowing. It is valid only because values yielded by `graph.possibleMaybeChanges` were originally created from `PrivatePossibleNodeChange` via the narrowing operation above.

Journal modules maintain internal widening/casting functions that follow the same pattern as `unsafeStringToNodeIdentifier`. Public callers MUST NOT access or depend on the widened representation.

---

## Out of scope

This PR does not specify:

- Persistence/serialization of public journal tokens.
- Long-lived cursor validity policies.
- Checkpoint/lease-based compaction safety.
- Type guards for storage/deserialization boundaries.
