# Report 3 — Strategy fitness analysis

## Goal
Ensure fatal failures are always displayed as errors in structured logs.

## Proposed strategy

1. Promote non-retryable transaction failure logging from `debug` to `error`.
2. In `working_repository` retry loops, keep `info` for retryable/intermediate failures, but add `error` logs exactly on terminal branches (no more retries / immediate rethrow).
3. Update tests to lock in the new behavior.

---

## Fitness against requirements

### Requirement match
- **“Fatal errors must always be displayed”**: strongly satisfied.
- Keeps transient retry noise manageable (not every transient failure becomes error).
- Preserves existing control flow and retry semantics.

### Risk profile
- **Low functional risk**: no algorithmic change, only logging-level decisions and additional terminal logs.
- **Low compatibility risk**: log volume increases only on fatal paths.

### Operational impact
- Better alertability and triage.
- Improved consistency between runtime termination and structured logging severity.

---

## Alternatives considered

### A) Promote *all* failure logs in retry callbacks to `error`
- **Pros:** simple policy.
- **Cons:** noisy; transient retries become false-positive alerts.
- **Verdict:** inferior for operator signal quality.

### B) Add global uncaught-exception handler that logs errors
- **Pros:** catches everything in one place.
- **Cons:** loses domain context (`attempt`, `workingPath`, retry metadata), can duplicate logs, and does not fix mis-leveled local telemetry.
- **Verdict:** useful as defense-in-depth, but not a substitute.

### C) Keep levels as-is, rely on Node stack traces
- **Pros:** zero code change.
- **Cons:** violates requirement; unstructured stderr output is poorer for monitoring.
- **Verdict:** unacceptable.

---

## Recommendation
Adopt the proposed targeted strategy (terminal-only error promotion). It has the best signal-to-noise ratio and minimal behavior risk while directly resolving the reported bug class.
