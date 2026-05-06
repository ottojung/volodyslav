# Gitstore

Gitstore is the persistence backbone of Volodyslav. It uses a local Git repository as an atomic, versioned data store. All writes to event logs and runtime state go through gitstore, giving every mutation a commit, a history, and built-in conflict resolution.

Gitstore exposes two write primitives:

| Primitive | One-liner |
|---|---|
| **`transaction`** | Clone → transform in temp dir → commit → push back. Retries on conflict. |
| **`checkpoint`** | Stage all changes in the working copy and commit directly. No remote involved. |

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

- A `RemoteLocation` – any URL or local filesystem path that Git can address.
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

## Checkpoints

A checkpoint is a lightweight alternative to a full transaction. It runs:

```
git add --all
git commit -m "$MESSAGE"
```

directly on the persistent local working copy – no clone, no temp directory, no push to a remote. If the working tree is already clean (no changes since the last commit), the checkpoint is a no-op: no new commit is created.

```javascript
await checkpoint(capabilities, workingPath, initial_state, message);
// returns void; creates a new commit only when there are changes to commit
```

### `checkpointSession` — multi-commit access

When you need to render files into the work tree and then commit, or when you need
more than one commit within a single mutex scope, use `checkpointSession`:

```javascript
await checkpointSession(capabilities, workingPath, initial_state, async ({ workDir, commit }) => {
    // render files into workDir, then commit
    await commit("pre-migration snapshot");
    // … run migration …
    await commit("post-migration snapshot");
});
```

`checkpointSession` acquires the same per-path mutex as `checkpoint` and provides:

- `workDir` — absolute path to the local working copy's work tree
- `commit(message)` — stages all changes and commits (no-op when clean)

### When to use a checkpoint vs. a transaction

| Situation | Use |
|---|---|
| You are the only writer (local-only `"empty"` repo), single commit | `checkpoint` |
| You are the only writer and need multiple commits or custom pre-commit work | `checkpointSession` |
| You need changes to survive a concurrent remote push | `transaction` |
| You want a cheap point-in-time snapshot before later synchronisation | `checkpoint` |
| You need to apply a read-modify-write against the latest remote state | `transaction` |

### Important: work-tree scope

A checkpoint commits the files that are physically present in the local working copy's work tree directory. It does **not** automatically include files committed by a preceding transaction.

A `transaction` pushes new commits into the working copy's `.git` directory but does **not** update the work tree on disk. A checkpoint that follows will commit the current work tree state, which may be missing those files. For this reason, avoid mixing transactions and checkpoints on the same `workingPath` unless you fully control what is in the work tree.

The typical safe pattern is:

- Use `transaction` for repositories that stage related changes before one final update.
- Use `checkpoint` / `checkpointSession` for local-only "empty" repositories (`runtime_state_storage` pattern) where the work tree is the single source of truth.

### No-op safety

When the working tree is clean (no changes since the last commit), `checkpoint` is a no-op: it runs `git add --all` and detects that there is nothing staged, so it skips the `git commit` call entirely. The function returns `void` without creating a commit.

### Mutex

Like `transaction`, `checkpoint` and `checkpointSession` acquire the per-`workingPath` mutex before doing any work. It is therefore safe to interleave checkpoints and transactions on the same `workingPath` from the same process without risking a partial commit.

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

## Synchronise vs. Transaction vs. Checkpoint

Three independent operations that work on the same local copy for different purposes.

| | `workingRepository.synchronize` | `gitstore.transaction` | `gitstore.checkpoint` |
|---|---|---|---|
| **Purpose** | Bi-directional sync with real remote | Atomically mutate files via temp work tree | Directly commit current working copy state |
| **Direction** | pull from remote, then push to remote, and for generators optionally merge other fetched hostname branches | clone → transform → push to working copy | `add --all` + `commit` on working copy |
| **Temp dir** | No | Yes (cleaned up always) | No |
| **Push to remote** | Yes | No (writes to local working copy only) | No |
| **Retries** | Up to 100 attempts | Up to `maxAttempts` (default 5) on `PushError` | None |
| **Nothing-to-commit** | N/A | N/A | No-op (skips commit) |
| **Mutex** | No | Yes | Yes |

`synchronize` is never called inside `transaction` or `checkpoint`. They operate independently: transactions and checkpoints write to the local working copy; synchronisation propagates those writes to the real remote and pulls in changes made elsewhere.

---

## Shallow Clones and Branch Convention

All clone operations use:

```
git clone --depth=1 --no-single-branch --branch=<hostname>-main
```

The clone stays shallow because of `--depth=1`, so only the branch tips are
fetched one commit deep. The active branch is derived from
`VOLODYSLAV_HOSTNAME` as `<hostname>-main`, and the hostname must match
`[0-9a-zA-Z_-]+`. Using `--no-single-branch` keeps all remote hostname branches
discoverable locally without pulling their full history.

For the generators database, synchronisation performs one extra reconciliation
pass after the normal pull/push (or clone/reset) flow:

1. `git fetch origin`
2. enumerate `refs/remotes/origin/*`
3. merge every matching `origin/<hostname>-main` branch except the current one

The merge uses `git merge --no-edit --allow-unrelated-histories` because host
branches may have diverged from separate roots. Merge failures are collected per
hostname so synchronisation can keep merging the remaining branches and then
report an organized summary of the hosts that failed.

### Sync reset targets (`Reset to Host`)

The sync API supports one reset payload form:

- `{"reset_to_hostname": "<hostname>"}` — reset to the specific hostname branch (`<hostname>-main`).

When `reset_to_hostname` is provided, the local working branch remains the
current host branch, but its files are reset to match
`origin/<hostname>-main` (including deletions). If that reset changes files, a
new commit is created with a merge-like reset message.
This is what powers the frontend **Reset to Host** mode.

To power the **Reset to Host** UI, the backend also exposes a hostname discovery
endpoint:

- `GET /api/sync/hostnames` — returns a JSON object with a `hostnames` array of
  available hostnames that can be used as `<hostname>` values in the
  `reset_to_hostname` payload.

Example response:

```json
{
  "hostnames": [
    "laptop",
    "desktop",
    "workstation"
  ]
}
```

---

## Module Map

| File | Responsibility |
|---|---|
| `index.js` | Public API: re-exports `transaction`, `checkpoint`, `checkpointSession`, and `workingRepository` |
| `transaction.js` | Acquires per-`workingPath` mutex, then delegates to retry layer |
| `transaction_retry.js` | Retry loop; distinguishes push vs. non-push errors |
| `transaction_attempt.js` | Single attempt: temp tree lifecycle, clone, transform, push |
| `checkpoint.js` | Checkpoint: `add --all` + `commit` directly on local working copy; no-op when clean (nothing to commit). Also exposes `checkpointSession` for multi-commit operations within one mutex scope. |
| `working_repository.js` | Persistent local copy: create, synchronize, expose `.git` path |
| `wrappers.js` | Thin wrappers over raw `git` calls: `clone`, `pull`, `push`, `commit`, `init`, `makePushable` |
| `transaction_logging.js` | Structured log messages for every stage of the retry lifecycle |
| `default_branch.js` | Derives the active branch name as `<hostname>-main` |

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
| `runtime_state_storage/transaction.js` | `"runtime-state-repository"` | `"empty"` | Writes transient runtime state; local-only, never pushed to a remote |
| `runtime_state_storage/synchronize.js` | `"runtime-state-repository"` | `"empty"` | Ensures the local-only runtime state repo exists |
| `generators/incremental_graph/database/gitstore.js` (`checkpointDatabase`) | `"generators-database"` | `"empty"` or a `RemoteLocation` | Records a single rendered snapshot commit of the live incremental-graph database |
| `generators/incremental_graph/database/gitstore.js` (`runMigrationInTransaction`) | `"generators-database"` | `"empty"` | Runs a migration recording pre/post rendered snapshot commits; uses `checkpointSession` (no temp clone or push) |

---

## Incremental-Graph Checkpoint Policy

`runMigrationInTransaction` (in `generators/incremental_graph/database/gitstore.js`)
wraps each `runMigration` call in a single `checkpointSession` and records two
commits — one before the migration callback runs and one after it completes
successfully. Normal incremental-graph writes do **not** trigger migration snapshots.

This is intentional.  LevelDB produces many small internal files at high frequency
during ordinary operation, and checkpointing every write would create an unbounded
stream of near-identical commits with little historical value.  Migration boundaries
represent discrete, application-level schema transitions that are worth preserving
as durable snapshots.

Because both `checkpointDatabase` and `runMigrationInTransaction` write to a
local-only (`"empty"`) repository that has no concurrent remote writers, they use
`checkpointSession` rather than `transaction`.  `checkpointSession` commits
directly to the persistent working copy's work tree — no temporary clone or
push step — while still acquiring the per-path mutex to serialise concurrent
in-process callers.

If the migration callback fails, the pre-migration commit is already visible in
the checkpoint repository.  This is intentional: it provides a useful diagnostic
snapshot of the database state immediately before the failed migration attempt.
(This differs from the previous transaction-based approach, where atomicity would
suppress the pre-migration commit on failure — leaving no checkpoint record of
the attempt at all.)
