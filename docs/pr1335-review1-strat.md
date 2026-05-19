# Strategy to address PR #1335 review feedback (round 1)

## Guiding principles
1. **Correctness over backward compatibility** for in-repo APIs.
2. **Atomicity mindset**: identifier-map updates must track graph-state mutations in the same commit unit.
3. **No redundant validation compute** for `NodeIdentifier` conversion in this pass.
4. **Defensive immutability boundaries** between resolver-local mutation and RootDatabase active cache.

## Strategic approach

### A) Fix replica-switch return-value bug first (local, low risk)
- Capture previous replica name before switching.
- Return whether switch actually changed replica.
- This unblocks accurate reopen behavior for callers.

### B) Redesign resolver persistence from "snapshot overwrite" to "delta merge"
- Track per-resolver allocation delta (new mappings only).
- At persistence time, merge delta into a fresh clone of latest active lookup.
- Persist merged lookup map, not resolver-local full snapshot.
- Rebase resolver local lookup to merged snapshot after queueing persistence.

This converts writes from *replace stale snapshot* to *merge latest + new entries*.

### C) Publish defensive clone into RootDatabase on commit
- Never pass mutable resolver object reference into root cache.
- Commit path should store clone of committed lookup snapshot.

### D) Keep NodeIdentifier conversion unchanged by design
- Do not add runtime format checks in `stringToNodeIdentifier` here.
- Add explicit in-code comment documenting compute-cost rationale for trusted internal boundary.

### E) Verify with focused + full checks
- Run targeted tests around identifier resolver / pull concurrency behavior.
- Then run full `npm test`, static analysis, and build.

## Risk management
- Main risk: introducing async/state coupling bugs in resolver commit flow.
- Mitigation: minimize API surface changes; keep resolver external contract stable where possible.
- Add/update tests to assert merge semantics and clone-on-commit behavior.
