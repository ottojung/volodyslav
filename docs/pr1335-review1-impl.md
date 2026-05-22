# PR #1335 Review — Implementation plan

This document provides a detailed implementation plan for addressing the feedback described in
`pr1335-review1.md`, following the strategy in `pr1335-review1-strat.md`.

The plan has one primary deliverable and one secondary deliverable.

---

## Step 1 — Write the specification document

**Output**: `docs/specs/incremental-graph-volatile-consistency.md`

This is the primary deliverable requested by the feedback.  The document must:

1. **Open with a high-level conceptual overview** covering:
   - The two-layer model (persisted vs volatile).
   - The role of `_computed` and why it exists.
   - The consistency guarantee the system provides.

2. **Define the data model** for the volatile layer:
   - What fields `_computed` contains.
   - The `IdentifierLookup` bijection: definition, invariants (bijective, monotonically growing,
     never shrinks).
   - The relationship between `_computed.identifierLookup` and the persisted
     `identifiers_keys_map`.

3. **State the invariants** in a testable form:
   - Superset invariant: `_computed.identifierLookup` always contains at least every entry in the
     most recently committed `identifiers_keys_map`.
   - Monotonicity invariant: no entry is ever removed from `_computed.identifierLookup`.
   - Serialisation invariant: all mutations of `_computed.identifierLookup` (and the concurrent DB
     commit) happen inside a single acquisition of `withComputedStateMutex`.
   - Atomic commit invariant: a new identifier mapping is visible in `_computed` only after the
     corresponding DB record has been durably written.

4. **Describe the initialisation protocol** (startup and replica cutover):
   - Steps to populate `_computed` from disk.
   - The mutex must be held while reading from disk and writing to `_computed`.
   - Lazy initialisation: the load happens on first need, not at construction.

5. **Describe the operation protocol** for any graph operation that touches identifiers:
   - The sequence of mutex acquisition, lookup, allocation, DB write, and `_computed` update.
   - How nested (recursive) dependency pulls share the outer operation's mutex context.

6. **Describe the replica cutover protocol**:
   - `withExclusiveMode` wraps the cutover.
   - After cutover, `_computed` reflects the new replica exclusively.

7. **List testable properties** at a level of detail sufficient for test generation:
   - Enumerate the properties a test suite can verify against any conforming implementation.
   - Include positive cases (allocation is visible after commit) and negative cases (concurrent
     conflicting allocations are impossible).

### Checklist for the specification document

- [ ] High-level overview (≤ 1 page): two-layer model, `_computed` role, consistency guarantee.
- [ ] Data model section: `_computed` fields, `IdentifierLookup` definition, relationship to disk.
- [ ] Invariants section: superset, monotonicity, serialisation, atomic commit.
- [ ] Initialisation protocol: steps, mutex requirements, lazy loading.
- [ ] Operation protocol: step-by-step with mutex boundaries marked.
- [ ] Replica cutover protocol: `withExclusiveMode`, `_computed` rebuild.
- [ ] Testable properties: at least 7 numbered properties, each independently verifiable.

---

## Step 2 — (Future code work) Implement the spec in the codebase

*This step is out of scope for the current task, which is to produce the specification.  It is
listed here so that future implementors can trace the connection from spec to code.*

The code changes required to make the codebase conform to the specification are:

### 2a — Move identifier allocation inside the mutex

In `graph_storage.js`, restructure `withIdentifierBatch` so that the `fn(batch)` callback does
**not** perform identifier allocation.  Instead:

1. Introduce a pre-pass (inside the mutex) that resolves all node keys that the operation needs
   before calling `fn`.
2. `fn(batch)` receives already-resolved `NodeIdentifier` values and performs only node-level
   reads/writes (no key-to-id translation).

Alternatively, if the pre-pass is impractical (because keys are discovered dynamically during
computation), use a design where each individual allocation is serialised:
- Remove the resolver snapshot pattern.
- Replace it with a function that, when called, immediately acquires the mutex, looks up or
  allocates the identifier in `_computed.identifierLookup`, commits the new entry to disk if
  needed, and releases the mutex.

### 2b — Eliminate the `IdentifierResolver` snapshot

- Remove the `pendingIdentifierMappings` map and the `applyPendingTo` method.
- Remove the `hasPendingAllocations` flag.
- Remove the lazy snapshot load in `makeIdentifierResolver`.

### 2c — Update `RootDatabaseClass` to support under-mutex lazy load

- Replace the current `initializeActiveIdentifierLookup()` (called eagerly at startup) with a
  method `ensureActiveIdentifierLookupLoaded()` that checks whether `_computed.identifierLookup`
  has been populated and, if not, loads it from disk.
- `ensureActiveIdentifierLookupLoaded()` must be called inside `withComputedStateMutex`.

### 2d — Update all callers

- Update `pull.js`, `recompute.js`, `invalidate.js`, and any other callers of `withIdentifierBatch`
  to use the new interface.
- Ensure that recursive sub-pulls within an operation do not create new mutex acquisitions for
  identifier work; they must share the outer context.

### 2e — Add tests for the new invariants

Write tests that verify each testable property listed in the specification document.  At minimum:

- A test that two concurrent operations for the same previously-unseen node key always produce the
  same identifier (i.e., the conflict scenario from Problem 2 cannot occur).
- A test that after a process-simulated restart (closing and re-opening the DB), all identifiers
  allocated in the previous session are still accessible.
- A test that a replica cutover leaves `_computed.identifierLookup` populated with the new
  replica's entries.

---

## Summary of deliverables

| Step | Output | Required now? |
|------|--------|--------------|
| 1 | `docs/specs/incremental-graph-volatile-consistency.md` | **Yes** |
| 2a–2e | Code changes to conform the implementation to the spec | No (future work) |
