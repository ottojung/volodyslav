# Report 3 — Strategy Fit Analysis and Alternatives Comparison

## Proposed strategy

1. In lifecycle startup (`internalEnsureInitialized`), before opening DB:
   - detect whether live DB directory exists.
2. If missing:
   - attempt `synchronizeNoLock({ resetToHostname: currentHostname })`.
3. If reset fails specifically because hostname branch is absent:
   - run `synchronizeNoLock()` (empty local -> normal merge sync).
4. Then proceed with normal open/format validation/version migration.

## Fit against required behavior

| Requirement | Fit |
|---|---|
| Missing DB -> reset-to-hostname attempt | Full |
| Missing remote host branch -> empty + normal sync | Full |
| Existing DB format mismatch -> crash | Full (already present) |
| Existing DB version mismatch -> migrate | Full (already present) |
| Deterministic startup ordering | Full |

## Comparison with alternatives

### Alternative A: always normal sync on missing DB (no reset attempt)
- **Rejected**: violates requirement to prefer host-specific reset first.

### Alternative B: always crash when reset branch missing
- **Rejected**: violates required fallback for first-time hosts.

### Alternative C: infer branch absence from string parsing generic git errors
- **Rejected**: brittle and locale/command-path dependent.

### Alternative D: retain old startup order and rely on periodic/manual sync
- **Rejected**: nondeterministic; migration/format checks operate on potentially wrong local state.

### Alternative E: implement compatibility loader for `xy-v1`
- **Rejected**: requirement says format mismatch must crash; also adds high-risk legacy pathway.

## Robustness analysis

### Strengths
- explicit branch-absence signal through typed error
- single startup decision point
- minimal change to proven migration/merge subsystems
- preserves strict crash semantics for structural invalidity

### Operational behavior
- host already has branch: reset path fast and deterministic
- brand-new host: controlled fallback to merge-based initialization
- bad/corrupt local format: immediate fail-fast
- schema drift: migration executes as designed

## Conclusion

The proposed strategy is the most fitting because it satisfies all constraints with low surface area and high determinism while avoiding speculative compatibility logic.
