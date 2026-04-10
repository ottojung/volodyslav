# Report 4 — Implementation plan

## Step 1: Fix fatal severity in centralized gitstore transaction logging
- Edit `backend/src/gitstore/transaction_logging.js`.
- Change `logNonRetryableError(...)` from `logger.logDebug(...)` to `logger.logError(...)`.
- Keep log payload/message unchanged for compatibility with dashboards/tests except level.

## Step 2: Add explicit terminal error logs in working repository retry loops
- Edit `backend/src/gitstore/working_repository.js`.

### 2.1 Synchronize loop
- In `synchronizeRetry` catch block:
  - Keep existing `logInfo` for attempt-level/transient failure telemetry.
  - Before `throw error` when no retry remains (`attempt >= 100`), emit `logError` with repository, attempt, and error details.
  - For `mergeHostBranches` immediate rethrow branch, emit `logError` before throw.

### 2.2 Empty repo initialization loop
- In `initializeEmptyRepositoryRetry` catch block:
  - Keep existing `logInfo` for transient failure.
  - Before terminal throw (`attempt >= 100`), emit `logError` with repository, attempt, and error details.

## Step 3: Update tests for behavior contract
- Edit `backend/tests/gitstore_retry.test.js`:
  - In non-push error test, switch expectation from `logDebug` to `logError` for “not retrying” message.
- Add/adjust tests in working repository suite if needed to verify terminal failure path emits `logError`.

## Step 4: Validate
Run:
1. `npm install`
2. `npm test`
3. `npm run static-analysis`
4. `npm run build`

Additionally run focused tests during iteration (e.g., `npx jest backend/tests/gitstore_retry.test.js`).

## Step 5: Commit and PR metadata
- Commit all code + docs changes.
- Create PR message with:
  - Problem statement (fatal errors hidden at low log level)
  - Solution summary (terminal error-level logging)
  - Test evidence.
