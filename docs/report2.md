# Report 2 — Codebase understanding focused on the issue

## Architecture context relevant to the bug

### 1) Transaction execution stack
For gitstore-backed operations, the execution path is:

1. `gitstore/transaction.js::transaction(...)`
   - acquires mutex via sleeper
2. `gitstore/transaction_retry.js::transactionWithRetry(...)`
   - wraps attempts with `withRetry(...)`
3. `gitstore/transaction_attempt.js::executeTransactionAttempt(...)`
   - clone temp tree, run transformation, push
4. underlying git wrappers (`gitstore/wrappers.js`) throw typed errors (notably `PushError`)

This means retry policy and retry logging are centralized in `transaction_retry.js` + `transaction_logging.js`.

### 2) Retryer behavior
`retryer/core.js::withRetry(...)` is generic and does not own error policy:
- it logs attempt execution at debug
- it does **not** catch callback errors
- callback decides when to `retry()` or throw

So fatal visibility must be handled by each retry callback (gitstore currently does this incompletely).

### 3) Logger API surface
`logger/index.js` exposes:
- `logError`, `logWarning`, `logInfo`, `logDebug`

All relevant modules already depend on capabilities logger abstraction (good fit with project conventions).

---

## Detailed flow of the reported failure type

When snapshot metadata validation throws (e.g., `InvalidSnapshotFormatError`):

- error originates in generators sync path
- bubbles into gitstore transaction callback
- reaches `transactionWithRetry` catch
- branch `!isPushError(error)` is taken
- `logNonRetryableError(...)` is called
- currently this logs at debug and rethrows

Hence the operation is non-retryable and terminal, but message is not logged as error.

---

## Why this matters specifically in this repo

The repository uses many long-running workflows and structured logs (bootstrap, sync, retries). In those scenarios:

- debug logs may be disabled in production
- info logs are often high-volume and not alerted
- error logs are typically routed to notifier/alert pipelines

Therefore fatal path messages should consistently use `logError` at terminal points.

---

## Related module behavior

### `gitstore/working_repository.js`
Contains additional retry loops for repo synchronization and initialization.

Current behavior:
- intermediate failures are `logInfo`
- terminal failures (attempt budget exhausted) throw without an explicit `logError`

This produces similar observability blind spots, even though control flow is technically correct.

### `gentlewrap.js`
User-facing/expected errors are `logError` + exit(1), so that path already follows desired visibility semantics.

---

## Testing landscape for this area

There is existing coverage in `backend/tests/gitstore_retry.test.js` that asserts logging behavior for:
- retry attempts
- final retry exhaustion
- non-push non-retry behavior

One existing test currently codifies the undesired behavior (expects debug for non-push fatal path). This test should be updated to error-level expectation.
