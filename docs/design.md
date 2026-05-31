# Incremental Graph Minimal Locking Design

## Purpose

This document defines the target locking and transaction design for the incremental graph. The design standard is production-grade medical software: correctness must be deterministic, auditable, recoverable, and independent of probability arguments.

The goal is to satisfy the incremental graph locking semantics while preserving volatile↔persistent synchronization:

1. `pull()` is mutually exclusive with `invalidate()` and inspection reads.
2. `invalidate()` calls may run concurrently with each other.
3. Inspection reads may run concurrently with `invalidate()`.
4. Pulls for the same concrete node serialize.
5. Pulls for disjoint concrete node sets may run concurrently.
6. The volatile identifier lookup never advances ahead of durable storage.
7. No two live transactions may ever hold the same newly generated node identifier, even transiently.

## Current architecture verified

### Graph activity phase locks

The graph already has a global mode-lock abstraction:

- `withObserveMode(...)` uses `GRAPH_ACTIVITY_KEY` in mode `"observe"`.
- `withPullMode(...)` uses `GRAPH_ACTIVITY_KEY` in mode `"pull"`.
- `withExclusiveMode(...)` combines exclusive operation serialization with `GRAPH_ACTIVITY_KEY` in mode `"exclusive"`.

This correctly expresses the high-level compatibility matrix: observe work can overlap observe work, pull work can overlap pull work, and different modes exclude each other.

### Pull path

Public pull entry points enter pull mode, serialize the requested node key, and call `pullNode(...)`. Nested pulls reuse the caller's transaction by passing `tx` explicitly through the stack. The current `tx.inFlight` map only deduplicates repeated pulls within one transaction; it is not a cross-transaction lock.

### Invalidation path

Invalidation enters observe mode and then runs a transaction. Since observe-mode callers can overlap, concurrent invalidations must be handled by idempotent or merge-based commit behavior rather than by a broad invalidation mutex.

### Inspection path

Inspection reads enter observe mode and read the volatile identifier lookup plus persistent graph sublevels. They are intentionally compatible with invalidation and excluded from pull activity.

### Current transaction path

The current transaction implementation creates:

- a private transaction identifier overlay backed by the active committed lookup;
- a read-your-writes batch wrapper;
- an operations array of raw LevelDB operations.

It currently protects the entire transaction body with `withComputedStateMutex(...)`. That is correct but too coarse: it serializes computor execution, dependency traversal, identifier allocation, and commit. The target design narrows that serialization to the places where shared state is actually mutated or published.

### Identifier allocation path

The allocation path is synchronous today:

```text
resolveConcreteNode(...)
  -> getOrAllocateNodeIdentifier(...)
    -> txAllocateNodeIdentifier(...)
      -> rootDatabase.generateNodeIdentifier()
        -> makeNodeIdentifier(...)
          -> random.basicString(...)
```

Within that path, lookup checks, random candidate generation, and `Map` writes are synchronous. There is no `await`, timer, I/O continuation, promise callback yield, or user callback in the check/generate/insert sequence.

In JavaScript running on one Node.js event loop, one synchronous call stack runs to completion before another graph operation can interleave. Therefore a synchronous check-and-insert reservation helper can be atomic without a sleeper mutex. This is an in-process guarantee; production deployment must still guarantee a single active writer process for one database replica. If multiple writer processes are permitted, identifier reservation must move to durable transactional storage with uniqueness semantics.

## Core design

The design uses three coordination mechanisms:

1. graph activity mode locks;
2. per-node pull locks;
3. a short commit merge/publish mutex.

Identifier reservation is deliberately **not** a mutex. It is a synchronous, non-yielding in-memory critical section.

## Data structures

### Root computed state

The active root database computed state should contain:

```javascript
{
    identifierLookup,
    inFlightIdentifiers,
    inFlightIdentifierOwners,
}
```

Where:

- `identifierLookup` is the committed in-memory `IdentifierLookup` loaded from durable storage and updated only after durable commit succeeds.
- `inFlightIdentifiers` is a `Set<string>` of generated identifier strings that have been reserved by live transactions but not yet committed or aborted.
- `inFlightIdentifierOwners` is optional but recommended for production diagnostics. It maps identifier strings to transaction IDs and supports assertion-quality error messages.

### Transaction state

A transaction should contain:

```javascript
{
    id,
    identifierLookup,
    reservedIdentifiers,
    inFlight,
    intents,
    heldPullNodeLocks,
}
```

Where:

- `id` is a diagnostic transaction ID.
- `identifierLookup` is the private overlay for newly allocated `nodeKey -> nodeIdentifier` mappings.
- `reservedIdentifiers` is the set of identifier strings reserved by this transaction.
- `inFlight` deduplicates repeated pulls inside the same transaction.
- `intents` records logical writes to be rebased and converted into raw operations at commit time.
- `heldPullNodeLocks` records per-node locks acquired by the transaction and released only after commit or abort.

## Lock set

### 1. Graph activity mode lock

Use the existing mode lock:

- `observe` for invalidation and inspection reads;
- `pull` for all pull work;
- `exclusive` for migrations, database open/reset/switch-replica operations, and other maintenance that must exclude graph activity.

This lock is acquired first.

### 2. Per-node pull locks

Every concrete node whose pull body executes must be protected by a per-node pull lock:

```text
PULL_NODE_KEY(nodeIdentifier or canonical nodeKey)
```

The lock must be held until the owning transaction commits or aborts, not merely until the computor returns. Releasing it earlier would allow another transaction to pull the same node while the first transaction's writes are still private, causing duplicate computation and potentially conflicting intents.

Nested dependency pulls acquire additional per-node locks as dependencies are traversed. Because the graph is a DAG, wait edges follow dependency edges and cannot form a cycle unless the graph itself contains a cycle, which construction already rejects.

### 3. Commit merge/publish mutex

Replace broad transaction-body serialization with a short commit mutex:

```text
COMMIT_KEY(activeReplica)
```

This mutex covers only:

1. rebasing transaction intents onto the latest committed state;
2. validating identifier reservations;
3. producing raw database operations;
4. flushing one durable batch;
5. publishing the committed identifier overlay into volatile memory;
6. clearing this transaction's identifier reservations.

No computor execution, dependency traversal, identifier generation, or identifier reservation happens under this mutex.

## Synchronous identifier reservation

### Contract

Identifier reservation must be implemented as a synchronous helper. It must not:

- `await`;
- return a promise;
- schedule callbacks;
- perform I/O;
- call user code;
- acquire a sleeper mutex;
- call any API that may yield to the event loop.

The helper performs a complete check/generate/reserve/update-overlay sequence before returning to the event loop.

### Algorithm

For `reserveNodeIdentifier(tx, rootDatabase, nodeKey)`:

1. If `nodeKey` already exists in `tx.identifierLookup`, return that identifier.
2. If `nodeKey` exists in the committed base lookup, return that identifier.
3. Generate a candidate identifier synchronously.
4. Check whether the committed base `idToKey` already contains the candidate.
5. Check whether `_computed.inFlightIdentifiers` already contains the candidate string.
6. If either check finds the candidate, generate a new candidate and repeat.
7. Insert the candidate string into `_computed.inFlightIdentifiers`.
8. Optionally record `candidate -> tx.id` in `_computed.inFlightIdentifierOwners`.
9. Insert `nodeKey -> candidate` into the transaction overlay.
10. Insert the candidate string into `tx.reservedIdentifiers`.
11. Return the candidate.

Steps 3 through 10 are one synchronous critical section. In one Node.js process, no second transaction can interleave between the duplicate check and the reservation insert.

### Abort cleanup

If a transaction aborts before durable commit succeeds:

1. synchronously remove every `tx.reservedIdentifiers` entry from `_computed.inFlightIdentifiers`;
2. remove owner diagnostics for the same identifiers;
3. release held pull-node locks;
4. discard transaction intents and overlays.

The committed volatile lookup is not changed on abort.

## Transaction intents

The current eager raw-operation batch is not sufficient for concurrent execution because some operations derive from shared records that may change before commit. The target design should record logical intents and render them under the commit mutex.

### Absolute node-owned intents

These records are owned by the node being pulled or invalidated and are safe under that node's ownership discipline:

- `values[node] = value`;
- `freshness[node] = state`;
- `inputs[node] = inputsRecord`;
- `counters[node] = counter`;
- `timestamps[node] = timestampRecord`.

### Merge intents for reverse dependencies

Reverse dependency records are shared by all dependents of one input. Eagerly writing the whole array can lose updates if two transactions add different dependents to the same input concurrently.

Represent reverse dependency updates as merge intents:

```text
revdepsAdd(inputIdentifier, dependentIdentifier)
```

Under the commit mutex:

1. read the latest committed `revdeps[inputIdentifier]`;
2. insert `dependentIdentifier` if absent;
3. keep the array sorted by node identifier;
4. write the merged array.

### Freshness intents

Represent freshness transitions explicitly:

- `markPotentiallyOutdated(node)` from invalidation;
- `markUpToDate(node)` from pull.

Pull and invalidation cannot overlap due to graph activity modes. Concurrent invalidations are idempotent. Concurrent pulls may both mark a shared dependency up to date; that is also idempotent.

## Commit protocol

Under `COMMIT_KEY(activeReplica)`:

1. Capture the latest active schema storage and active committed identifier lookup.
2. Rebase transaction identifier overlay onto the latest committed lookup.
3. For each transaction overlay mapping:
   1. If the committed lookup already maps the node key to an identifier, use that committed identifier as canonical and rewrite transaction intents from the reserved identifier to the canonical identifier.
   2. Otherwise assert that the reserved identifier is still present in `tx.reservedIdentifiers` and `_computed.inFlightIdentifiers`.
   3. Assert that the committed lookup does not map the reserved identifier to a different node key.
   4. Add the mapping to the merged lookup snapshot.
4. Render node-owned intents into raw database operations.
5. Render reverse-dependency merge intents against the latest committed records.
6. If identifier mappings changed, include a raw put of the full serialized identifier lookup in the same durable batch as node-state writes.
7. Await the durable batch.
8. After the batch succeeds, publish identifier mappings into the volatile committed lookup.
9. Synchronously clear this transaction's entries from `_computed.inFlightIdentifiers` and owner diagnostics.
10. Release held pull-node locks.
11. Return the transaction result.

The durable write happens before volatile publication. If durable write fails, volatile lookup remains unchanged and reservations are cleared during abort cleanup.

## Crash and recovery behavior

### Crash before durable batch success

No volatile identifier publication has occurred. Durable state remains at the previous committed version. In-memory reservations disappear with the process.

### Crash after durable batch success but before volatile publication

The process dies before in-memory state matters again. On restart, the active identifier lookup is loaded from durable storage and includes the committed batch.

### Crash after volatile publication

Durable state already contains the same identifier lookup and node-state batch. Restart reconstructs the same committed state.

## Inspection consistency

Inspection reads remain observe-mode and are excluded from pulls. They may overlap invalidations by design.

For single-record inspection reads (`getValue`, `getFreshness`, timestamps), observe-mode compatibility is sufficient because invalidation changes are idempotent and pull writes are excluded.

For multi-record inspection reads that combine volatile lookup data with persistent sublevel scans, prefer one of these implementation choices:

1. read after the no-`await` disk-success-to-volatile-publish window; or
2. use a short read-side commit mutex around the multi-record read.

The second option is stricter and easier to audit. It blocks only the publish window, not invalidation computation.

## Multi-process requirement

The synchronous reservation guarantee is in-process. Production deployment must enforce exactly one active writer process per database replica. If multiple writer processes are required, `_computed.inFlightIdentifiers` must become a durable reservation table with transactional uniqueness, and commit must verify/clear that durable reservation.

## Lock ordering

The required order is:

1. graph activity mode lock;
2. per-node pull locks during dependency traversal;
3. synchronous identifier reservation helper as needed (no mutex, no await);
4. commit merge/publish mutex;
5. release commit mutex;
6. release per-node pull locks.

Never acquire graph activity mode while holding per-node pull locks or the commit mutex. Never call user computors while holding the commit mutex.

## Required tests

1. Concurrent pulls of disjoint nodes both enter computors before either completes.
2. Concurrent pulls of the same node serialize until the first transaction commits.
3. Concurrent pulls that share only one dependency serialize only on that dependency.
4. Nested pulls reuse the outer transaction and do not reacquire transaction-body locks.
5. A deterministic fake random source returning the same candidate to two live transactions causes the second synchronous reservation to retry.
6. A transaction abort clears all `inFlightIdentifiers` reservations and does not mutate the committed lookup.
7. A durable batch failure leaves volatile lookup unchanged and clears reservations.
8. Concurrent reverse-dependency additions to the same input preserve every dependent.
9. Concurrent invalidations of the same previously unmaterialized node converge on one canonical identifier and clear non-canonical reservations.
10. Restart after durable batch success reconstructs the identifier lookup and node-state graph from persistent storage.
11. Inspection reads do not observe volatile identifier mappings that were not durably flushed.
12. Exclusive migration/open/reset work blocks pull and observe activity while it mutates replica state.

## Implementation sequence

1. Add `inFlightIdentifiers` and optional owner diagnostics to active root computed state.
2. Add transaction IDs and `reservedIdentifiers` to transaction state.
3. Replace direct `txAllocateNodeIdentifier(...)` calls with a synchronous reservation-aware allocator.
4. Add per-node pull locks and hold them through transaction commit or abort.
5. Replace eager raw batch recording for shared records with transaction intents.
6. Add commit merge/publish mutex scoped only to rebase, render, durable batch, volatile publication, and reservation cleanup.
7. Add failure injection tests for durable batch rejection and reservation cleanup.
8. Add deterministic duplicate-candidate tests using a fake random source.
9. Add concurrency tests for disjoint pulls, shared dependency pulls, same-node pulls, invalidations, reverse-dependency merges, and inspection consistency.
