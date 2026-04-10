# Report 3 — Strategy Fit Analysis and Alternatives

## Proposed strategy

1. In reset bootstrap mode, validate remote snapshot `_meta/format` first.
2. Only if format is valid, validate `_meta/current_replica`.
3. Delay opening/initializing live LevelDB in reset mode until after both validations pass.
4. Import reset snapshot into a staged temporary live DB and swap it into place only after full import succeeds.
5. Fix error value rendering so `undefined` is rendered as `undefined` (unquoted), not `"undefined"`.
6. Add tests for ordering, diagnostics, and deterministic repeated failure behavior.

## Fit against requirements

### Requirement: fail before replica check when format is wrong

- **Fit:** exact; strategy enforces format gate before any replica pointer gate.

### Requirement: restart must fail the same way, no silent repair

- **Fit:** high; delaying live DB initialization avoids persistent side effects on failed reset bootstrap, so next restart re-enters same failure condition.
- **Fit:** stronger with staged swap; even late failures during scan/import do not mutate existing live DB.

### Requirement: never auto-repair incompatible DB

- **Fit:** high; strategy removes accidental local-state creation path that looked like repair.

### Requirement: diagnostic quality

- **Fit:** high; dedicated format error class + corrected undefined rendering gives unambiguous failure classification.

## Alternatives considered

### Alternative A: keep early DB open, but add extra guard in lifecycle

Example: store a marker "bootstrap incomplete" and force reset path again.

- Pros: minimal synchronize.js refactor.
- Cons: introduces additional boot-state bookkeeping and potential new inconsistency states.
- Cons: still allows side effects before validation, contrary to strict fail-fast design.

### Alternative B: delete live DB directory on bootstrap failure

- Pros: could restore deterministic startup.
- Cons: destructive rollback behavior is riskier and effectively a repair heuristic.
- Cons: violates the spirit of "never repair" and can hide root causes.

### Alternative C: support legacy `xy-v1` and migrate during reset

- Pros: friendlier compatibility.
- Cons: explicitly out-of-scope/non-goal per boot sequence document.
- Cons: expands migration complexity and weakens strict structural contract.

## Selected strategy rationale

The selected strategy is the minimal-correctness change set that:

- aligns exactly with the documented boot protocol,
- avoids new state machines/markers,
- preserves strict fail-fast semantics,
- prevents hidden side effects that make crashes non-reproducible on restart.

## Risk assessment

- **Primary risk:** behavior change in reset mode skipping pre-sync checkpoint.
  - Mitigation: reset mode is restore-from-remote path; checkpointing local live DB before reset is not required for correctness.
- **Secondary risk:** tests relying on previous (incorrect) error class.
  - Mitigation: update tests to encode spec-correct behavior.

Overall risk is low-to-moderate and tightly bounded to reset bootstrap flow.
