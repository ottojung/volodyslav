# Report 1 — Fatal-error visibility bug investigation

## Trigger log recap
The provided log shows a transaction attempt that fails with `InvalidSnapshotFormatError`, but the failure is only emitted as:

- `DEBUG: Gitstore transaction failed with non-push error - not retrying`

Then the process crashes with an uncaught exception stack trace.

That means the *application logger* treats a fatal failure as debug-level telemetry, while the *runtime* still terminates. This is exactly the visibility gap you pointed out.

---

## What counts as “same class of bug”
I treated this as:

> A failure that escapes control flow (or ends retry loop and escapes), but is logged only at `debug`/`info` level, so production operators may miss it.

---

## Confirmed cases

### 1) Non-retryable gitstore transaction errors are logged at debug
**File:** `backend/src/gitstore/transaction_logging.js`

`logNonRetryableError(...)` currently calls `logger.logDebug(...)` with message:

- `Gitstore transaction failed with non-push error - not retrying`

This path is used in `transaction_retry.js` when `!isPushError(error)`, and that branch immediately rethrows. So this is a fatal-attempt exit path being logged at debug level.

### 2) `working_repository.synchronize` terminal failure is only info-logged
**File:** `backend/src/gitstore/working_repository.js`

Inside retry callback `synchronizeRetry`, any failure logs:

- `logInfo(..., "Failed to synchronize repository")`

If attempt limit is reached (`attempt >= 100`), the same error is thrown. No error-level log is produced at the terminal attempt.

Also, `mergeHostBranches` errors are rethrown immediately after the same info-level log.

### 3) `initializeEmptyRepository` terminal failure is only info-logged
**File:** `backend/src/gitstore/working_repository.js`

Inside retry callback `initializeEmptyRepositoryRetry`, failures log:

- `logInfo(..., "Repository initialization did not succeed sucessfully")`

If attempts are exhausted (`attempt >= 100`), it throws, again without an error-level log.

---

## Severity assessment
- **Operational severity:** high (fatal conditions can be filtered out in log pipelines that suppress debug/info).
- **Diagnostic impact:** medium-high (stack trace exists in stderr, but structured error telemetry in logger is missing or mis-leveled).
- **Correctness impact:** medium (runtime behavior still fails fast, but observability policy “fatal errors must always be displayed” is violated).

---

## Root cause pattern
The code mixes two concerns inside retry callbacks:
1. progress/transient telemetry
2. terminal/fatal telemetry

But terminal branches reuse non-terminal log levels (`debug` or `info`) and then throw, relying on uncaught exception output instead of explicit `logError`.
