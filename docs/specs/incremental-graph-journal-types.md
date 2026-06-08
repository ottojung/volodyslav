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

A `JournalEntry` is an internal type. Ordinary users of `graph.possibleMaybeChanges` do not receive `JournalEntry` values. The public API surface uses `PossibleNodeChange`.

### JournalAction

```js
/**
 * The kind of change recorded in a journal entry.
 * @typedef {'add' | 'edit' | 'delete'} JournalAction
 */
```

- `'add'` — a node became materialized for the first time.
- `'edit'` — a node's stored value materially changed.
- `'delete'` — a node was removed or superseded (by synchronization or conflict resolution).

---

## UnixTimestamp

`UnixTimestamp` is an integer count of milliseconds since the Unix epoch (January 1, 1970, 00:00:00 UTC). This is consistent with JavaScript's `Date.now()` and `Date.prototype.getTime()`.

REQ-JT-01: The unit of `UnixTimestamp` MUST be integer milliseconds. Fractional timestamps MUST NOT be used.

REQ-JT-02: Implementations SHOULD record journal timestamps using the local system clock at the time of emission. Host clocks are not assumed to be synchronized across hosts.

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

A `Hostname` is a string that uniquely identifies a host within the synchronization mesh. The specific source of the value (e.g., machine hostname, configured name, stable UUID) is implementation-defined, but the value MUST be stable across restarts of the same host.

REQ-JT-03: A `Hostname` MUST be stable for a given host across process restarts and reboots.

REQ-JT-04: Two distinct hosts in the synchronization mesh MUST have different `Hostname` values. If two hosts accidentally share a hostname, tie-breaking falls through to the next deterministic rule (see `incremental-graph-journal-sync.md`).

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

A `JournalIndex` is a replicated physical journal position within the journal storage system. It is NOT exposed in the public `graph.possibleMaybeChanges` API signature.

REQ-JT-05: `JournalIndex` values MUST NOT be reused.

REQ-JT-06: Gaps in the `JournalIndex` sequence are acceptable.

REQ-JT-07: `JournalIndex` MUST NOT be exposed in the public `graph.possibleMaybeChanges` API signature.

### Nominal typing

```js
class JournalIndexClass {
    /** @private @type {undefined} */ __brand;
    constructor() { if (this.__brand !== undefined) throw new Error("JournalIndex cannot be instantiated"); }
}

/** @typedef {JournalIndexClass} JournalIndex */
```

Conversion functions:

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

The next journal index to allocate is maintained in volatile state (analogous to the `_nextNodeIndex` pattern in identifier allocation). The last committed journal index watermark is stored in global metadata:

```
rendered/r/global/last_journal_index
```

REQ-JT-08: `last_journal_index` MUST NOT decrease.

REQ-JT-09: After synchronization, `last_journal_index` MUST be at least the greatest index that is present or known-absent due to synchronized journal state.

---

## PrivatePossibleNodeChange (internal)

### Purpose

The journal implementation internally needs a wider representation that pairs a `JournalEntry` with its storage `JournalIndex`. This internal type is NOT exported as public API. Only journal modules may construct, inspect, or cast through this type.

```js
/**
 * Private journal-module-only representation.
 * This is not exported as public API.
 *
 * @typedef {object} PrivatePossibleNodeChange
 * @property {JournalAction} action
 * @property {NodeIdentifier} id
 * @property {NodeKey} key
 * @property {UnixTimestamp} time
 * @property {Hostname} creator
 * @property {JournalIndex} index
 */
```

`PrivatePossibleNodeChange` extends `JournalEntry` with the `index` field.

### Conversion functions (journal modules only)

```js
/**
 * Journal module only.
 * Converts a private journal entry occurrence into the public nominal token.
 *
 * @param {PrivatePossibleNodeChange} change
 * @returns {PossibleNodeChange}
 */
function privatePossibleNodeChangeToPossibleNodeChange(change)

/**
 * Journal module only.
 * Unsafe widening from public nominal token back to the private representation.
 * This is allowed only inside the journal implementation.
 *
 * @param {PossibleNodeChange} change
 * @returns {PrivatePossibleNodeChange}
 */
function possibleNodeChangeToPrivatePossibleNodeChangeUnsafe(change)
```

The important property:

- `PossibleNodeChange` is not itself the structural cursor type.
- The journal implementation creates it from `PrivatePossibleNodeChange`.
- The journal implementation may widen it back to `PrivatePossibleNodeChange`.
- Ordinary public callers MUST NOT inspect or depend on `JournalIndex`, `NodeIdentifier`, or `Hostname`.

The internal widening follows the same pattern as `unsafeStringToNodeIdentifier` in the database types: an unsafe cast that journal modules control at their module boundary. Public callers never see the widened representation.

---

## PossibleNodeChange (public)

### Purpose

`PossibleNodeChange` is the public unit of journal observation. It is yielded by `graph.possibleMaybeChanges` and may be passed as the `since` argument in future calls. Every `PossibleNodeChange` is derived from a committed journal entry.

```js
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
 * @typedef {object} PossibleNodeChange
 * @property {NodeName} nodeName - The head/functor of the affected node.
 * @property {Array<ConstValue>} bindings - The positional bindings of the
 *   affected node.
 * @property {JournalAction} action - The kind of possible change.
 * @property {UnixTimestamp} time - When the change was recorded.
 */
```

REQ-JT-10: `PossibleNodeChange` MUST expose `nodeName`, `bindings`, `action`, and `time` as public fields. It MUST NOT expose `NodeIdentifier`, `JournalIndex`, `Hostname`, or any other journal-internal metadata.

REQ-JT-11: A `PossibleNodeChange` returned by `graph.possibleMaybeChanges` MUST have `nodeName` and `bindings` that correspond to a valid node key in the graph at the time the change was recorded.

---

## BaselinePossibleNodeChange (public)

### Purpose

`BaselinePossibleNodeChange` is a sentinel token returned by `baselinePossibleNodeChange()`. It represents a position before any journal entry and is NOT derived from a committed journal entry. It is a separate type from `PossibleNodeChange`.

```js
/**
 * Sentinel returned by `baselinePossibleNodeChange()`.
 * Not a possible node change. Not derived from a journal entry.
 * Only valid as a `since` argument to `graph.possibleMaybeChanges(...)`.
 *
 * The properties that this type carries are:
 * - The value represents "before any journal entry."
 * - Its only valid use is as a `since` argument.
 *
 * The proof of those properties is guaranteed by:
 * - This type can only be introduced through this operation:
 *   - `baselinePossibleNodeChange()`: satisfies the property because it
 *     returns a sentinel representing a position before any committed journal
 *     entry.
 *
 * @typedef {object} BaselinePossibleNodeChange
 */
```

Despite sharing a similar nominal shape, `BaselinePossibleNodeChange` does not represent a possible node change and carries no change information. Its only valid use is as a `since` argument. When passed as `since`, the graph treats it as a position before any committed journal entry.

### Widening behavior for baseline

If `since` is `BaselinePossibleNodeChange`, scanning starts before the first journal entry. The journal module may internally widen `BaselinePossibleNodeChange` to a private representation analogous to `PrivatePossibleNodeChange` with a sentinel `index` value (e.g., -1 or 0) that precedes all real indices. Ordinary public callers MUST NOT depend on the internal sentinel index value.

```js
/**
 * Journal module only.
 * Converts the baseline sentinel into a private representation suitable
 * for internal cursor positioning.
 *
 * @param {BaselinePossibleNodeChange} baseline
 * @returns {PrivateBaselinePossibleNodeChange}
 */
function baselinePossibleNodeChangeToPrivateUnsafe(baseline)

/**
 * Journal module only.
 * The private sentinel representation, never exposed publicly.
 * @typedef {object} PrivateBaselinePossibleNodeChange
 * @property {JournalIndex} index - A sentinel index before all real indices.
 */
```

---

## Nominal boundary summary

Both `PossibleNodeChange` and `BaselinePossibleNodeChange` are nominal public journal tokens with different public semantics:

- `PossibleNodeChange`: journal-backed change token with meaningful public fields (`nodeName`, `bindings`, `action`, `time`). Every `PossibleNodeChange` is derived from a committed journal entry via `privatePossibleNodeChangeToPossibleNodeChange`.

- `BaselinePossibleNodeChange`: sentinel token used only as an initial `since` value. It carries no change information and is not derived from a journal entry.

The journal implementation internally uses `PrivatePossibleNodeChange` which includes the `JournalIndex`. The conversion direction is:

| Direction | Function | Permitted in |
|-----------|----------|--------------|
| Private → Public | `privatePossibleNodeChangeToPossibleNodeChange` | Journal modules only |
| Public → Private | `possibleNodeChangeToPrivatePossibleNodeChangeUnsafe` | Journal modules only |
| Public | `graph.possibleMaybeChanges` yields | Public API |

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
│  Private fields: NOT visible                 │
│      (id, key, creator, index)               │
└──────────────────────────────────────────────┘
```

Journal modules maintain internal widening/casting functions that follow the same pattern as `unsafeStringToNodeIdentifier`. Public callers MUST NOT access or depend on the widened representation.

---

## Type guards

```js
/**
 * @param {unknown} value
 * @returns {value is PossibleNodeChange}
 */
function isPossibleNodeChange(value)

/**
 * @param {unknown} value
 * @returns {value is BaselinePossibleNodeChange}
 */
function isBaselinePossibleNodeChange(value)
```

These type guards are available for use at storage/deserialization boundaries where untyped `unknown` data is converted into nominal journal token types. Ordinary callers of `graph.possibleMaybeChanges` receive already-typed values and do not need to re-verify them at the call site.

---

## Out of scope

This PR does not specify:

- How callers should persist `PossibleNodeChange` values across restarts.
- How long a stored `since` token remains valid.
- How stored tokens behave after migration, sync, or storage scenarios.
- Checkpoint/lease-based compaction safety for long-lived stored cursors.

These concerns are deferred to future specifications.
