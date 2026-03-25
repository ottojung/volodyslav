# Runtime State Storage

The `runtime_state_storage` module persists server-side operational state
across requests and process restarts.  It exposes a single **transaction**
primitive so that every read-modify-write cycle is atomic and concurrent
callers never observe a half-written state.

---

## Why a transaction, not get/set?

A naïve `get` / `set` pair is racy: two concurrent callers can each read the
same state, modify it independently, and then overwrite each other's changes.
For example, two tasks updating their `lastSuccessTime` simultaneously would
silently drop one of the updates.

Instead, every interaction with the state goes through a **transaction
callback**.  The module:

1. reads the current state from the database *before* calling the callback,
2. hands a `RuntimeStateStorage` object to the callback (the callback can read
   and optionally replace the state),
3. and writes the new state *after* the callback returns — all in a single
   database operation.

In-process concurrency is handled by a promise-chain **mutex** that serialises
all transactions so they run one after another, never overlapping.

---

## Module layout

```
backend/src/runtime_state_storage/
  index.js        – make() factory; exports the RuntimeStateCapability object
  transaction.js  – core transaction logic (read → callback → write)
  class.js        – RuntimeStateStorage class (setState / getExistingState /
                    getCurrentState / getNewState)
  structure.js    – serialization, deserialization, schema migration, makeDefault
  types.js        – JSDoc @typedef declarations (RuntimeState, TaskRecord, …)
  errors.js       – all custom error classes and their type guards
  synchronize.js  – ensureAccessible helper for startup health-checks
```

---

## Capability interface

`make(getCapabilities)` returns a `RuntimeStateCapability` object:

```js
const { make } = require('./runtime_state_storage');
const stateCapability = make(() => capabilities);

// capabilities.state.transaction(async (storage) => { … })
// capabilities.state.ensureAccessible()
```

### `transaction(f)`

```
transaction<T>(f: (storage: RuntimeStateStorage) => Promise<T>): Promise<T>
```

Runs `f` inside a serialised, atomic transaction.  `f` receives a
`RuntimeStateStorage` instance with the following methods:

| Method | Description |
|---|---|
| `setState(state)` | Queue `state` to be written to the DB when the transaction ends. |
| `getNewState()` | Return the state queued by `setState`, or `null`. |
| `getExistingState()` | Lazily deserialize and return the state that was in the DB at transaction start, or `null` if absent. |
| `getCurrentState()` | Return `getNewState()` if set; otherwise `getExistingState()`; otherwise a fresh default state. |

`f` may read the current state, modify it, and call `setState` with the result.
If `f` does not call `setState`, the database is not written.

The return value of `f` is forwarded as the return value of `transaction`.

If either the database read, `f`, or the database write throws, the error
propagates to the caller.  The mutex is always released even on failure, so
subsequent transactions are never blocked.

### `ensureAccessible()`

```
ensureAccessible(): Promise<void>
```

Performs a lightweight read from the database to confirm it is reachable.
Throws `RuntimeStateStorageAccessError` if the database cannot be opened.
Intended for startup health-checks.

---

## State schema

### `RuntimeState`

```js
{
  version: number,       // always 2 (RUNTIME_STATE_VERSION)
  startTime: DateTime,   // ISO timestamp of the last process start
  tasks: TaskRecord[],   // persisted task scheduler records
}
```

### `TaskRecord`

```js
{
  name: string,                   // unique task identifier
  cronExpression: string,         // cron schedule string
  retryDelayMs: number,           // non-negative integer, retry back-off in ms
  lastSuccessTime?: DateTime,     // ISO timestamp of last successful run
  lastFailureTime?: DateTime,     // ISO timestamp of last failed run
  lastAttemptTime?: DateTime,     // ISO timestamp of last attempt (either outcome)
  pendingRetryUntil?: DateTime,   // deadline for pending retry after failure
  schedulerIdentifier?: string,   // which scheduler instance started the task
}
```

---

## Serialization

`structure.serialize(state)` converts a `RuntimeState` to a plain JSON-safe
object suitable for database storage.  DateTime fields are encoded as ISO 8601
strings.  Tasks are sorted by `name` so the stored representation is
deterministic.

`structure.tryDeserialize(obj)` is the inverse.  It returns either a
`DeserializeOk` (with `{ state, taskErrors, migrated }`) or a subclass of
`TryDeserializeError`.  Individual malformed task entries are collected as
`taskErrors` rather than failing the whole deserialization — the valid tasks are
still returned.

### Schema migration

Version 1 records (without a `tasks` array) are silently migrated to version 2
on read.  The `migrated` flag in `DeserializeOk` is set to `true` in that case;
the migration is persisted on the next `setState` call.

---

## Atomicity and serialization guarantees

| Concern | Mechanism |
|---|---|
| Concurrent in-process callers | Promise-chain mutex in `index.js` serialises all `transaction` calls. |
| Database write atomicity | A single LevelDB `put` call inside `temporary.setRuntimeState()`. LevelDB guarantees atomicity for single-key writes. |
| Failed transactions do not corrupt state | If `f` throws before calling `setState`, no write is issued. If the DB write throws, the mutex is still released and the state on disk is unchanged. |

---

## Persistence

The state is kept under the key `runtime_state/current` in the LevelDB
instance at `<workingDirectory>/temporary-leveldb/`.  This is the same
database used by the `temporary` module for uploaded-file blobs and request
markers — see [`docs/temporary.md`](./temporary.md) for details about that
database.

---

## Error types

All custom errors are defined in `errors.js` and re-exported from
`structure.js`:

| Class | When thrown |
|---|---|
| `RuntimeStateCorruptedError` | The value on disk cannot be deserialized (structure error); contains the `TryDeserializeError` cause. |
| `RuntimeStateStorageAccessError` | `ensureAccessible()` could not reach the database. |
| `TryDeserializeError` (and subclasses) | Returned *as values* from `tryDeserialize`; not thrown directly. |

---

## Testing and mocking

Tests that do not need a real database can use the helpers from
`backend/tests/stubs.js`:

```js
const { stubRuntimeStateStorage, mockRuntimeStateTransaction } = require('./stubs');

// Replace capabilities.state with an in-memory mock:
stubRuntimeStateStorage(capabilities);
// capabilities.state.transaction(...) now uses in-memory storage.

// Or call the mock directly without a full capabilities object:
await mockRuntimeStateTransaction(capabilities, async (storage) => {
    storage.setState(someState);
    const current = await storage.getCurrentState();
});
```

The mock preserves state between transactions (within a single test), making it
suitable for integration-style tests that exercise multiple sequential
transactions.

---

## Usage example

```js
const { make } = require('./runtime_state_storage');

// Wire up once (e.g. in capabilities/root.js):
capabilities.state = make(() => capabilities);

// Read the current task list and add a new task record:
await capabilities.state.transaction(async (storage) => {
    const state = await storage.getCurrentState();
    state.tasks.push({
        name: 'send-digest',
        cronExpression: '0 8 * * *',
        retryDelayMs: 60_000,
    });
    storage.setState(state);
});

// Read the state without modifying it:
const taskCount = await capabilities.state.transaction(async (storage) => {
    const state = await storage.getCurrentState();
    return state.tasks.length;
});
```
