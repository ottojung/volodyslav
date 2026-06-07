# IncrementalGraph Journal Types

## Purpose

This document defines the core types used by the IncrementalGraph journal: journal entries, timestamps, host identifiers, journal indices, and the public `PossibleNodeChange` observation token.

All journal types follow the existing nominal/opaque typing discipline used by `NodeIdentifier`, `NodeKeyString`, `NodeName`, and related IncrementalGraph types. See `backend/src/generators/incremental_graph/database/types.js` and `docs/specs/keys-design.md` for the established patterns.

---

## JournalEntry

### Shape

```js
/**
 * A single journal entry recording a graph change.
 * @typedef {object} JournalEntry
 * @property {JournalAction} action - The kind of change recorded.
 * @property {NodeIdentifier} id - The node identifier of the affected node.
 * @property {NodeKey} key - The semantic node key at the time of the change.
 * @property {UnixTimestamp} time - When the change was recorded.
 * @property {Hostname} creator - The host that recorded the change.
 */
```

A `JournalEntry` is an internal type. It is NOT exposed through the public `possibleMaybeChanges` API. The public API surface uses `PossibleNodeChange` (see below).

### JournalAction

```js
/**
 * The kind of change recorded in a journal entry.
 * @typedef {'add' | 'edit' | 'delete'} JournalAction
 */
```

- `'add'` — a node became materialized for the first time.
- `'edit'` — a node's stored value materially changed.
- `'delete'` — a node was removed or superseded (by synchronization, migration, or conflict resolution).

---

## UnixTimestamp

```js
/**
 * An integer count of milliseconds since the Unix epoch (January 1, 1970, 00:00:00 UTC).
 * @typedef {number} UnixTimestamp
 */
```

`UnixTimestamp` is a number representing milliseconds since the Unix epoch. This is consistent with JavaScript's `Date.now()` and `Date.prototype.getTime()`.

REQ-JT-01: The unit of `UnixTimestamp` MUST be integer milliseconds. Fractional timestamps MUST NOT be used.

REQ-JT-02: Implementations SHOULD record journal timestamps using the local system clock at the time of emission. As with all distributed-system clocks, incorrect host clocks may affect conflict resolution outcomes (see `incremental-graph-journal-sync.md`).

### Nominal typing

`UnixTimestamp` is a typedef-only nominal type:

```js
class UnixTimestampClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("UnixTimestamp cannot be instantiated"); }
}

/** @typedef {UnixTimestampClass} UnixTimestamp */
```

The following conversion functions MUST be provided:

```js
/**
 * @param {number} value
 * @returns {UnixTimestamp}
 */
function numberToUnixTimestamp(value)

/**
 * @param {UnixTimestamp} timestamp
 * @returns {number}
 */
function unixTimestampToNumber(timestamp)
```

---

## Hostname

```js
/**
 * An opaque identifier for a host within the synchronization mesh.
 * @typedef {string} Hostname
 */
```

A `Hostname` is a string that uniquely identifies a host. The specific source of the value (e.g., machine hostname, configured name, stable UUID) is implementation-defined, but the value MUST be stable across restarts of the same host.

REQ-JT-03: A `Hostname` MUST be stable for a given host across process restarts and reboots.

REQ-JT-04: Two distinct hosts in the synchronization mesh MUST have different `Hostname` values. If two hosts accidentally share a hostname, tie-breaking falls through to the next deterministic rule (see `incremental-graph-journal-sync.md`).

### Nominal typing

`Hostname` follows the same nominal pattern as `NodeName`:

```js
class HostnameClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("Hostname cannot be instantiated"); }
}

/** @typedef {HostnameClass} Hostname */
```

```js
/**
 * @param {string} value
 * @returns {Hostname}
 */
function stringToHostname(value)

/**
 * @param {Hostname} hostname
 * @returns {string}
 */
function hostnameToString(hostname)
```

---

## JournalIndex

```js
/**
 * An opaque numeric index into the journal storage.
 * Monotonic, non-reusable, used only by the journal storage layer.
 * @typedef {number} JournalIndex
 */
```

A `JournalIndex` is a monotonic allocation watermark for journal entries. It is analogous to `last_node_index` in the node identifier system.

REQ-JT-05: `JournalIndex` values MUST NOT be reused.

REQ-JT-06: Gaps in `JournalIndex` sequence are acceptable.

REQ-JT-07: `JournalIndex` MUST NOT be exposed in the public `possibleMaybeChanges` API signature. It is an internal journal-storage concern.

### Nominal typing

```js
class JournalIndexClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("JournalIndex cannot be instantiated"); }
}

/** @typedef {JournalIndexClass} JournalIndex */
```

```js
/**
 * @param {number} value
 * @returns {JournalIndex}
 */
function numberToJournalIndex(value)

/**
 * @param {JournalIndex} index
 * @returns {number}
 */
function journalIndexToNumber(index)
```

### Journal index storage

The next journal index to allocate is maintained in volatile state (analogous to the `_nextNodeIndex` pattern in identifier allocation).

The last committed journal index watermark is stored in global metadata:

```
rendered/r/global/last_journal_index
```

REQ-JT-08: `last_journal_index` MUST NOT decrease.

REQ-JT-09: `last_journal_index` is the greatest journal index that has been durably committed. Gaps below it are allowed.

---

## PossibleNodeChange

### Purpose

`PossibleNodeChange` is the public unit of journal observation. It is returned by `possibleMaybeChanges` and can be stored by consumers to pass as the `since` argument in future calls.

### Public view

From the perspective of a public consumer, a `PossibleNodeChange` carries:

- The identity of a node that may have changed (expressed as a node key: `NodeName` and bindings).
- The kind of possible change (`JournalAction`).
- The time when the change was recorded (`UnixTimestamp`).

Public consumers may inspect these fields. Public consumers may pass a `PossibleNodeChange` value back to `possibleMaybeChanges`. Public consumers MUST NOT construct `PossibleNodeChange` values directly.

### Nominal boundary

`PossibleNodeChange` is a nominal type. The public API exposes it as an opaque journal observation token. The journal implementation internally uses a wider structural representation that may include journal-specific metadata (such as the underlying `JournalIndex`). This follows the same pattern as `NodeIdentifier` — the type remains nominal at boundaries, and controlled journal modules may cast or convert it internally.

```
┌──────────────────────────────────────────┐
│           Public API boundary            │
│                                          │
│  possibleMaybeChanges(                   │
│      since: PossibleNodeChange,          │
│      to: NodeFilter,                     │
│  ): AsyncIterator<PossibleNodeChange>     │
│                                          │
│  Public fields: node key, action, time   │
│  Internal fields: NOT visible            │
└──────────────────────────────────────────┘
```

### Public representation

```js
/**
 * The properties that this type carries are:
 * - The value came from the journal system (returned by possibleMaybeChanges).
 * - It represents a possible change to a graph node.
 * - The public fields (nodeKey, action, time) accurately describe the change.
 *
 * The proof of those properties is guaranteed by:
 * - This type can only be introduced through these functions:
 *   - `possibleMaybeChanges(...)`: satisfies the property because it only yields
 *     PossibleNodeChange values derived from committed journal entries.
 *
 * Plain objects must not be treated as PossibleNodeChange values unless they pass
 * through this introduction path.
 * @typedef {object} PossibleNodeChange
 * @property {NodeName} nodeName - The head/functor of the affected node.
 * @property {Array<ConstValue>} bindings - The positional bindings of the affected node.
 * @property {JournalAction} action - The kind of possible change.
 * @property {UnixTimestamp} time - When the change was recorded.
 */
```

REQ-JT-10: `PossibleNodeChange` MUST expose `nodeName`, `bindings`, `action`, and `time` as the only public fields. It MUST NOT expose `NodeIdentifier`, `JournalIndex`, `Hostname`, or any other journal-internal metadata to ordinary public API callers.

REQ-JT-11: A `PossibleNodeChange` returned by `possibleMaybeChanges` MUST have `nodeName` and `bindings` that correspond to a valid node key in the graph at the time the change was recorded.

### Type guard

```js
/**
 * @param {unknown} value
 * @returns {value is PossibleNodeChange}
 */
function isPossibleNodeChange(value)
```

### Internal widening

The journal storage layer internally needs a wider representation that includes the `JournalIndex` so it can scan, compare, and resume from stored positions. This internal representation is NOT the `PossibleNodeChange` type itself — it is a wider type used only inside journal modules.

The journal modules may use an unsafe cast or widening pattern at their internal boundaries, following the same convention as `unsafeStringToNodeIdentifier` in the database types. Public callers MUST NOT access or depend on the widened representation.
