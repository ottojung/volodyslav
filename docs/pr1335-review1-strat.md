# PR #1335 Review Thread 1 — Strategy

## Strategy principles

1. **Single-source domain truth per layer**
   - runtime orchestration may translate;
   - storage and storage-facing APIs remain identifier-native;
   - semantic operations must use resolved semantic keys consistently once resolved.

2. **Atomicity of logically-coupled writes**
   - identifier lookup persistence must not be best-effort;
   - if merge applies data changes, lookup writes must be committed before dependent phases.

3. **Deterministic collision progression**
   - deterministic fallback generation must consume retry attempt to generate new candidates.

4. **Minimal, review-targeted surface area**
   - fix only affected paths first;
   - avoid broad refactors that blur validation outcomes.

## Remediation strategy by issue

### A) Sync merge flush safety
After queueing the merged `identifiers_keys_map` write and invoking chunk flush helper, explicitly commit residual pending ops and clear buffer before revdep/pointer steps.

### B) Allocation retry propagation
Make allocation callback accept `attempt` and pass it to deterministic fallback generator.

### C) Pull semantic-key consistency
Resolve semantic key once at function start (best-effort fallback only when reverse lookup is absent), then use that resolved semantic key for:
- node key deserialization,
- concrete node get/create key,
- pull mutex key,
- error diagnostics tied to pull key context.

## Verification strategy
- Run focused tests around incremental graph database and pull behavior.
- Run full suite + static analysis + build to ensure no regressions.
