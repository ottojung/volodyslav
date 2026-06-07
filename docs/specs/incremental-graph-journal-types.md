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

A `JournalEntry` is an internal type. It is NOT exposed through the public `graph.possibleMaybeChanges` API. The public API surface uses `PossibleNodeChange` (see below).

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
 * A replicated physical journal position.
 * Allocated monotonically by a host. After synchronization, each index
 * has cross-host meaning: all synchronized hosts agree that the entry
 * at a given index is either the same JournalEntry or absent.
 * Divergent entries at the same index are temporary and must be
 * resolved by synchronization.
 * @typedef {number} JournalIndex
 */
```

A `JournalIndex` is a replicated physical journal position. Hosts may allocate journal entries independently before sync, producing divergent entries at the same index temporarily. Synchronization resolves that divergence so that after sync each index is consistent across all synchronized hosts (see `incremental-graph-journal-sync.md` REQ-JS-15).

REQ-JT-05: `JournalIndex` values MUST NOT be reused.

REQ-JT-06: Gaps in `JournalIndex` sequence are acceptable.

REQ-JT-07: `JournalIndex` MUST NOT be exposed in the public `graph.possibleMaybeChanges` API signature. It is an internal journal-storage concern.

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

The next journal index to allocate is maintained in volatile state (analogous to the `_nextNodeIndex` pattern in identifier allocation). A host allocates indices independently; since `JournalIndex` is a plain numeric position with no host-specific namespace, two hosts can allocate the same index before sync, producing temporary divergent entries. Synchronization resolves such divergence (see `incremental-graph-journal-sync.md` REQ-JS-16). Divergent entries are not stable across sync until physical convergence resolves them.

The last committed journal index watermark is stored in global metadata:

```
rendered/r/global/last_journal_index
```

REQ-JT-08: `last_journal_index` MUST NOT decrease.

REQ-JT-09: After synchronization, `last_journal_index` MUST be at least the greatest index that is present or known-absent due to synchronized journal state. This includes indices from remote hosts that were adopted, indices that were resolved by divergent-index resolution, and freshly allocated indices from conservative appends. Gaps below the watermark are allowed.

---

## PossibleNodeChange

### Purpose

`PossibleNodeChange` is the public unit of journal observation. It is returned by `graph.possibleMaybeChanges` and can be stored by consumers to pass as the `since` argument in future calls.

### Public view

`PossibleNodeChange` has two distinct sources, and the meaning of its public fields depends on the source:

- **Values yielded by `graph.possibleMaybeChanges`**: These are derived from committed journal entries. Public consumers may inspect `nodeName`, `bindings`, `action`, and `time` to learn about the recorded change.
- **The sentinel returned by `baselinePossibleNodeChange()`**: This is a universal sentinel representing "before any journal entry." It is NOT derived from a committed journal entry. Its public fields (`nodeName`, `bindings`, `action`, `time`) carry no meaningful value and MUST NOT be inspected. The sentinel's only valid use is as a `since` argument to `graph.possibleMaybeChanges`.

Regardless of source, public consumers may pass any `PossibleNodeChange` value back to `graph.possibleMaybeChanges`. Public consumers MUST NOT construct `PossibleNodeChange` values directly.

REQ-JT-10a: Public consumers MUST NOT inspect `nodeName`, `bindings`, `action`, or `time` on the baseline sentinel returned by `baselinePossibleNodeChange()`. These fields are meaningful only on values yielded by `graph.possibleMaybeChanges`.

### Nominal boundary

`PossibleNodeChange` is a nominal type. The public API exposes it as an opaque journal observation token. The journal implementation internally uses a wider structural representation that may include journal-specific metadata (such as the underlying `JournalIndex`). This follows the same pattern as `NodeIdentifier` — the type remains nominal at boundaries, and controlled journal modules may cast or convert it internally.

```
┌──────────────────────────────────────────┐
│           Public API boundary            │
│                                          │
│  graph.possibleMaybeChanges({            │
│      since,                              │
│      to,                                 │
│  }): AsyncIterator<PossibleNodeChange>    │
│                                          │
│  Public fields: nodeName, bindings,      │
│                 action, time             │
│  Internal fields: NOT visible            │
└──────────────────────────────────────────┘
```

### Public representation

```js
/**
 * The properties that this type carries are:
 *
 * For values yielded by `graph.possibleMaybeChanges`:
 * - The value is derived from a committed journal entry.
 * - `nodeName`, `bindings`, `action`, and `time` accurately describe the
 *   recorded change.
 *
 * For the sentinel returned by `baselinePossibleNodeChange()`:
 * - The value represents "before any journal entry."
 * - `nodeName`, `bindings`, `action`, and `time` carry no meaningful value
 *   and MUST NOT be inspected.
 * - The sentinel's only valid use is as a `since` argument to
 *   `graph.possibleMaybeChanges`.
 *
 * For all values of this type:
 * - The value may be stored and passed as `since` to
 *   `graph.possibleMaybeChanges`.
 *
 * The proof of those properties is guaranteed by:
 * - This type can only be introduced through these operations:
 *   - `graph.possibleMaybeChanges(...)`: satisfies the property because it only
 *     yields PossibleNodeChange values derived from committed journal entries,
 *     and each yielded value carries the public fields of that entry.
 *   - `baselinePossibleNodeChange()`: satisfies the property because it returns
 *     a sentinel PossibleNodeChange representing a position before any
 *     committed journal entry. The sentinel is not derived from any journal
 *     entry, and its public fields are not defined.
 *
 * Plain objects must not be treated as PossibleNodeChange values unless they
 * pass through this introduction path.
 * @typedef {object} PossibleNodeChange
 * @property {NodeName} nodeName - The head/functor of the affected node.
 *   Meaningful only on values yielded by `graph.possibleMaybeChanges`.
 * @property {Array<ConstValue>} bindings - The positional bindings of the
 *   affected node. Meaningful only on values yielded by
 *   `graph.possibleMaybeChanges`.
 * @property {JournalAction} action - The kind of possible change. Because
 *   `graph.possibleMaybeChanges` is conservative, the `action` field describes
 *   the journal entry that produced the possible change; consumers MUST NOT
 *   treat it as an exactly-once semantic event. Meaningful only on values
 *   yielded by `graph.possibleMaybeChanges`.
 * @property {UnixTimestamp} time - When the change was recorded. Meaningful
 *   only on values yielded by `graph.possibleMaybeChanges`.
 */
```

REQ-JT-10: `PossibleNodeChange` MUST expose `nodeName`, `bindings`, `action`, and `time` as the only public fields. It MUST NOT expose `NodeIdentifier`, `JournalIndex`, `Hostname`, or any other journal-internal metadata to ordinary public API callers.

REQ-JT-11: A `PossibleNodeChange` returned by `graph.possibleMaybeChanges` MUST have `nodeName` and `bindings` that correspond to a valid node key in the graph at the time the change was recorded.

### Type guard

`isPossibleNodeChange(value)` is a type guard for use at storage, deserialization, and serialization boundaries where untyped `unknown` data is converted into the nominal `PossibleNodeChange` type. Ordinary callers of `graph.possibleMaybeChanges` receive already-typed `PossibleNodeChange` values and do not need to re-verify them at the call site.

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
