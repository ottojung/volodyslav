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

## PossibleNodeChange and BaselinePossibleNodeChange

### Purpose

`PossibleNodeChange` is the public unit of journal observation. It is yielded by `graph.possibleMaybeChanges` and can be stored by consumers to pass as the `since` argument in future calls.

`BaselinePossibleNodeChange` is a separate sentinel type returned by `baselinePossibleNodeChange()`. It represents a position before any journal entry and is only valid as a `since` argument. It is NOT a `PossibleNodeChange`.

### PossibleNodeChange

`PossibleNodeChange` is a regular journal-backed possible change. Every `PossibleNodeChange` value is derived from a committed journal entry and is yielded by `graph.possibleMaybeChanges`. Public consumers may inspect its `nodeName`, `bindings`, `action`, and `time` fields to learn about the recorded change.

```js
/**
 * A real journal-backed possible node change.
 * Yielded by `graph.possibleMaybeChanges(...)`.
 *
 * @typedef {object} PossibleNodeChange
 * @property {NodeName} nodeName - The head/functor of the affected node.
 * @property {Array<ConstValue>} bindings - The positional bindings of the
 *   affected node.
 * @property {JournalAction} action - The kind of possible change. Because
 *   `graph.possibleMaybeChanges` is conservative, the `action` field describes
 *   the journal entry that produced the possible change; consumers MUST NOT
 *   treat it as an exactly-once semantic event.
 * @property {UnixTimestamp} time - When the change was recorded.
 */
```

REQ-JT-10: `PossibleNodeChange` MUST expose `nodeName`, `bindings`, `action`, and `time` as public fields. It MUST NOT expose `NodeIdentifier`, `JournalIndex`, `Hostname`, or any other journal-internal metadata to ordinary public API callers.

REQ-JT-11: A `PossibleNodeChange` returned by `graph.possibleMaybeChanges` MUST have `nodeName` and `bindings` that correspond to a valid node key in the graph at the time the change was recorded.

### BaselinePossibleNodeChange

`BaselinePossibleNodeChange` is a sentinel token returned by `baselinePossibleNodeChange()`. It is NOT a `PossibleNodeChange` — it is a separate type representing a position "before any journal entry" and is not derived from a committed journal entry.

```js
/**
 * Sentinel returned by `baselinePossibleNodeChange()`.
 * Not a possible node change.
 * Only valid as a `since` argument to `graph.possibleMaybeChanges(...)`.
 * @typedef {object} BaselinePossibleNodeChange
 */
```

Despite sharing a similar nominal shape, `BaselinePossibleNodeChange` does not represent a possible node change and carries no change information. Its only valid use is as a `since` argument. When passed as `since`, the graph treats it as a position before any committed journal entry and yields all currently available surviving `PossibleNodeChange` values.

REQ-JT-10a: `BaselinePossibleNodeChange` is not derived from a journal entry and carries no change information. The sentinel's only valid use is as a `since` argument.

### Nominal boundary

Both `PossibleNodeChange` and `BaselinePossibleNodeChange` are nominal public journal tokens, but they have different public semantics:

- `PossibleNodeChange`: a journal-backed change token with meaningful public fields (`nodeName`, `bindings`, `action`, `time`). Every `PossibleNodeChange` is an actual possible node change derived from a committed journal entry.

- `BaselinePossibleNodeChange`: a sentinel token used only as an initial `since` value. It carries no change information and is not derived from a journal entry.

The journal implementation internally uses a wider structural representation that may include journal-specific metadata (such as the underlying `JournalIndex`). The internal widening/casting rules may apply to both token types if the implementation needs hidden cursor metadata. This follows the same pattern as `NodeIdentifier` — the type remains nominal at boundaries, and controlled journal modules may cast or convert it internally.

```
┌──────────────────────────────────────────────┐
│              Public API boundary             │
│                                              │
│  graph.possibleMaybeChanges({                │
│      since,                                  │
│      to,                                     │
│  }): AsyncIterator<PossibleNodeChange>       │
│                                              │
│  baselinePossibleNodeChange():               │
│      BaselinePossibleNodeChange              │
│                                              │
│  Public fields (PossibleNodeChange):         │
│      nodeName, bindings, action, time        │
│  Internal fields: NOT visible                │
└──────────────────────────────────────────────┘
```

### Public representation

```js
/**
 * The properties that this type carries are:
 * - The value is derived from a committed journal entry.
 * - `nodeName`, `bindings`, `action`, and `time` accurately describe the
 *   recorded change.
 * - The value may be stored and passed as `since` to
 *   `graph.possibleMaybeChanges`.
 *
 * The proof of those properties is guaranteed by:
 * - This type can only be introduced through this operation:
 *   - `graph.possibleMaybeChanges(...)`: satisfies the property because it
 *     only yields PossibleNodeChange values derived from committed journal
 *     entries, and each yielded value carries the public fields of that entry.
 *
 * Plain objects must not be treated as PossibleNodeChange values unless they
 * pass through this introduction path.
 * @typedef {object} PossibleNodeChange
 * @property {NodeName} nodeName - The head/functor of the affected node.
 * @property {Array<ConstValue>} bindings - The positional bindings of the
 *   affected node.
 * @property {JournalAction} action - The kind of possible change.
 * @property {UnixTimestamp} time - When the change was recorded.
 */

/**
 * The properties that this type carries are:
 * - The value represents "before any journal entry."
 * - It does not represent a possible node change.
 * - Its only valid use is as a `since` argument to
 *   `graph.possibleMaybeChanges`.
 *
 * The proof of those properties is guaranteed by:
 * - This type can only be introduced through this operation:
 *   - `baselinePossibleNodeChange()`: satisfies the property because it
 *     returns a sentinel representing a position before any committed journal
 *     entry.
 *
 * Plain objects must not be treated as BaselinePossibleNodeChange values
 * unless they pass through this introduction path.
 * @typedef {object} BaselinePossibleNodeChange
 */
```

### Type guards

`isPossibleNodeChange(value)` is a type guard for use at storage, deserialization, and serialization boundaries where untyped `unknown` data is converted into the nominal `PossibleNodeChange` type. Ordinary callers of `graph.possibleMaybeChanges` receive already-typed `PossibleNodeChange` values and do not need to re-verify them at the call site.

```js
/**
 * @param {unknown} value
 * @returns {value is PossibleNodeChange}
 */
function isPossibleNodeChange(value)
```

`isBaselinePossibleNodeChange(value)` is a type guard for `BaselinePossibleNodeChange`. It is needed at the same storage/deserialization boundaries because a computor may store a `BaselinePossibleNodeChange` if the journal iterator yielded no entries (see `incremental-graph-journal-computors.md` §Stored state conventions).

```js
/**
 * @param {unknown} value
 * @returns {value is BaselinePossibleNodeChange}
 */
function isBaselinePossibleNodeChange(value)
```

### Validation pattern for `since` values

At boundaries where an `unknown` serialized token is recovered and passed to `graph.possibleMaybeChanges`, the validation pattern is:

```js
/** @param {unknown} storedToken */
function recoverSinceToken(storedToken) {
    if (isPossibleNodeChange(storedToken)) return storedToken;
    if (isBaselinePossibleNodeChange(storedToken)) return storedToken;
    // Token is unrecognizable; fall back to a fresh baseline.
    return baselinePossibleNodeChange();
}
```

This pattern ensures that storage/deserialization can safely recover both allowed token shapes (`PossibleNodeChange | BaselinePossibleNodeChange`) without introducing a named union type in the public API.

### Internal widening

The journal storage layer internally needs a wider representation that includes the `JournalIndex` so it can scan, compare, and resume from stored positions. This internal representation is NOT the public `PossibleNodeChange` or `BaselinePossibleNodeChange` types — it is a wider type used only inside journal modules. Both public token types may share the same internal widened representation when additional cursor metadata is needed.

The journal modules may use an unsafe cast or widening pattern at their internal boundaries, following the same convention as `unsafeStringToNodeIdentifier` in the database types. Public callers MUST NOT access or depend on the widened representation.
