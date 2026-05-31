# PR #1335 Review 1 Strategy

## Design standard

The strategy follows `docs/design.md`: correctness must be deterministic, auditable, and recoverable. We should not rely on random identifier collision probabilities or broad serialization that hides races by preventing all useful concurrency. We should make each shared-state mutation explicit and keep each lock scoped to the invariant it protects.

## Principles

1. **Preserve disk-first volatile consistency.**
   The in-memory committed identifier lookup may never include an allocation that was not durably written in the same batch as its node-state writes.

2. **Do not serialize computor execution with the commit mutex.**
   Computors and dependency traversal are user/application work. The commit lock should protect only durable/publish shared state.

3. **Reserve identifiers synchronously, not probabilistically.**
   A live transaction must reserve candidate identifiers in an in-memory set before returning to the event loop. Candidate generation must retry against both committed lookup and live reservations.

4. **Use locks for ownership, not as a substitute for validation.**
   Pull-mode activity remains separated from observe/exclusive activity by the existing mode lock. Concrete pull locks protect same-node and known shared dependency execution. The commit mutex protects final merge/publish.

5. **Clean up on every abort path.**
   Any transaction that throws before durable commit must clear its reserved identifiers without mutating committed lookup.

6. **Update tests to express target semantics.**
   Tests that previously asserted broad transaction serialization should instead assert disjoint-pull overlap, same-node serialization, shared dependency serialization, duplicate-candidate retry, and batch-failure cleanup.

## Strategy

1. Keep PR #1335's identifier-native storage and disk-first transaction overlay model as the base.
2. Add live reservation state to root computed state: `inFlightIdentifiers` and `inFlightIdentifierOwners`.
3. Extend transactions with diagnostic IDs and `reservedIdentifiers`.
4. Replace `txAllocateNodeIdentifier(...)` use in graph transaction allocation with a synchronous reservation helper.
5. Move `withComputedStateMutex(...)` from whole transaction body to the commit section.
6. Add concrete pull locks. At minimum, top-level pulls must lock their output and static input keys in canonical order so disjoint pulls can overlap and shared static dependencies serialize before duplicate computation.
7. Preserve transaction-local nested pull deduplication through `tx.inFlight`.
8. Add focused tests first, then iterate with the existing volatile consistency and concurrency suites.
9. Defer full logical-intent rebasing of every graph write to a later, larger change unless tests expose lost updates; this pass should make no regression in current persisted state and should not introduce partial durable/volatile publication.

## Non-goals for this pass

- Multi-process writer support. The synchronous reservation guarantee is explicitly in-process.
- A durable reservation table.
- Replacing every eager raw batch operation with logical intents in one step.
