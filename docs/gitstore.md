# Gitstore

Gitstore is the persistence backbone of Volodyslav. It uses a local Git repository as an atomic, versioned data store. All writes to event logs and runtime state go through gitstore transactions, giving every mutation a commit, a history, and built-in conflict resolution.

---

## Core Idea

Instead of writing files directly, callers hand gitstore a *transformation* function. Gitstore:

1. Prepares a fresh, writable directory containing the current state of the data.
2. Calls the transformation with that directory.
3. Commits any changes the transformation made.
4. Pushes the new commit back to the authoritative store.

If the push fails (because another concurrent writer already advanced the head), the entire cycle repeats from the beginning: re-fetch, re-apply, re-push. This makes every transaction *optimistic* – conflicts are resolved by retrying, not by locking the remote.

---

## Repository Roles

There are three distinct repository objects involved in any operation.

### The Authoritative Store (Remote)

The source of truth. It can be:

- A `RemoteLocation` – any URL or local filesystem path that Git can address. For the event log this is the path stored in `environment.eventLogRepository()`.
- The string `"empty"` – no remote exists; the system creates a fresh local-only repository the first time.

### The Local Working Copy

A persistent clone of the authoritative store, kept on disk inside `environment.workingDirectory()` under the name given to `workingPath`. The working copy has `receive.denyCurrentBranch = ignore` so that other repositories can push into it directly.

`workingRepository.getRepository(capabilities, workingPath, initial_state)` is the gatekeeper:

- If the local copy does not yet exist (no `HEAD` file), it is created:
  - For a `RemoteLocation`: cloned from the remote URL, then made pushable.
  - For `"empty"`: a new repo is initialised, made pushable, and seeded with one empty commit so the branch exists.
- If the local copy already exists, the call returns immediately without touching the remote.

The return value is the path to the `.git` directory of the working copy.

### The Temporary Work Tree

Created fresh for every transaction attempt. It is a `--depth=1` clone of the local working copy's `.git` directory. The transformation function receives a `GitStore` handle that exposes this directory via `store.getWorkTree()` and offers a `store.commit(message)` method.

The temp tree is always deleted in the `finally` block, whether the transaction succeeded or failed.

---

## Transaction Lifecycle

```
transaction(capabilities, workingPath, initial_state, transformation)
  │
  ├─ acquire in-process mutex for workingPath
  │
  └─ transactionWithRetry
        │
        ├─ attempt N (up to maxAttempts):
        │    │
        │    ├─ workingRepository.getRepository  →  ensure local working copy exists
        │    ├─ makeTemporaryWorkTree             →  create temp directory
        │    ├─ clone(localGitDir, tempDir)       →  shallow clone into temp
        │    ├─ transformation(store)             →  caller modifies files, calls store.commit()
        │    ├─ push(tempDir → localGitDir)       →  push new commits into working copy
        │    └─ deleteDirectory(tempDir)          →  always runs, success or failure
        │
        └─ on PushError: wait delayMs, retry from top of attempt loop
           on any other error: rethrow immediately (no retry)
```

The mutex (`capabilities.sleeper.withMutex`) ensures that within the same process only one transaction for a given `workingPath` runs at a time. Cross-process or cross-machine conflicts are handled by the push-and-retry loop.

---

## Retry Semantics

Only `PushError` (thrown by `wrappers.push`) triggers a retry. Every other error propagates immediately to the caller.

The default retry configuration is 5 attempts with 0 ms delay. Callers can supply a `RetryOptions` object:

```javascript
/**
 * @typedef {object} RetryOptions
 * @property {number} maxAttempts
 * @property {number} delayMs
 */
```

A retry is a full restart: the temp tree is discarded, the working copy is re-examined, a new temp tree is cloned, and the transformation is executed again from scratch. Callers must therefore treat the transformation as *pure* – it should derive all state from the work tree provided by `store.getWorkTree()`, not from external mutable state accumulated across calls.

---

## Synchronise vs. Transaction

These are two separate, complementary operations.

| | `workingRepository.synchronize` | `gitstore.transaction` |
|---|---|---|
| **Purpose** | Keep local working copy in sync with real remote | Atomically mutate files in the local working copy |
| **Direction** | pull from remote, then push to remote | transformation → commit → push to local working copy |
| **When called** | On startup, or periodically, by `event_log_storage/synchronize` | On every write operation |
| **Retries** | Up to 100 attempts (internal, `withRetry`) | Up to `maxAttempts` (default 5) on push failure |

`synchronize` is never called inside `transaction`. They operate independently: transactions write to the local working copy; synchronisation propagates those writes to the real remote and pulls in changes made elsewhere.

---

## Shallow Clones and Branch Convention

All clone operations use:

```
git clone --depth=1 --single-branch --branch=master
```

Only the latest commit is fetched. The branch is always `master` (exported from `default_branch.js`). This keeps temp work trees lightweight regardless of how many commits the repository has accumulated.

---

## Module Map

| File | Responsibility |
|---|---|
| `index.js` | Public API: re-exports `transaction` and `workingRepository` |
| `transaction.js` | Acquires per-`workingPath` mutex, then delegates to retry layer |
| `transaction_retry.js` | Retry loop; distinguishes push vs. non-push errors |
| `transaction_attempt.js` | Single attempt: temp tree lifecycle, clone, transform, push |
| `working_repository.js` | Persistent local copy: create, synchronize, expose `.git` path |
| `wrappers.js` | Thin wrappers over raw `git` calls: `clone`, `pull`, `push`, `commit`, `init`, `makePushable` |
| `transaction_logging.js` | Structured log messages for every stage of the retry lifecycle |
| `default_branch.js` | Single constant: `'master'` |

---

## Error Types

| Error class | Thrown by | Meaning |
|---|---|---|
| `PushError` | `wrappers.push` | The `git push` command failed; triggers retry in the transaction loop |
| `WorkingRepositoryError` | `working_repository.synchronize`, `initializeEmptyRepository`, `getRepository` | Could not establish a usable local copy of the repository |
| `GitUnavailable` | `wrappers.ensureGitAvailable` | The `git` executable is not on `$PATH` |

All three follow the project's error-as-value convention: use the corresponding `is*` type guard rather than `instanceof` at call sites.

---

## Known Callers

| Caller | `workingPath` | `initial_state` | Usage |
|---|---|---|---|
| `event_log_storage/transaction.js` | `"working-git-repository"` | `{ url: environment.eventLogRepository() }` | Appends events, writes config, copies assets |
| `event_log_storage/synchronize.js` | `"working-git-repository"` | `{ url: environment.eventLogRepository() }` | Bi-directional sync with remote on startup / request |
| `runtime_state_storage/transaction.js` | `"runtime-state-repository"` | `"empty"` | Writes transient runtime state; local-only, never pushed to a remote |
| `runtime_state_storage/synchronize.js` | `"runtime-state-repository"` | `"empty"` | Ensures the local-only runtime state repo exists |
