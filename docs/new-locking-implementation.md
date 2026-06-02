# Alternative locking implementation for IncrementalGraph

## Context

Pull request [#1335](https://github.com/ottojung/volodyslav/pull/1335) changes
`IncrementalGraph` from semantic `NodeKey`-addressed persistence to opaque
`NodeIdentifier`-addressed persistence. The intent is good: translate a user-supplied semantic key to
an identifier once, then keep graph storage identifier-native. The PR discussion repeatedly pushed in
that direction: graph storage must not understand `NodeKey`, and non-migration code should not accept
legacy/malformed graph data.

The difficult part is no longer only the identifier mapping. It is the synchronization boundary around
all mutable graph state:

- the LevelDB sublevels (`values`, `freshness`, `inputs`, `revdeps`, `counters`, `timestamps`),
- the persisted `global/identifiers_keys_map`,
- the volatile identifier lookup inside `RootDatabase`,
- the set of in-flight generated identifiers,
- per-node recomputation/invalidation state, and
- replica pointer swaps during migration or synchronization.

The current PR solves this with several explicit lock classes. A simpler alternative is a single
logical graph worker (an actor/serializer) that owns the graph state and accepts messages such as
`pull`, `invalidate`, `allocateIdentifier`, `commitBatch`, `checkpoint`, `migrate`, and `sync`.
This report evaluates that approach.

## Current locking shape in the PR

The current implementation uses multiple process-local synchronization mechanisms:

1. **Activity modes** in `lock.js`:
   - `observe` for ordinary inspections/invalidations,
   - `pull` for pull operations, and
   - `exclusive` for migrations and other operations that must exclude all graph activity.
2. **An exclusive-operation mutex** (`MUTEX_KEY`) to serialize exclusive callers before they acquire
   the graph activity lock.
3. **A commit mutex** keyed by replica name. It serializes durable batch flushes and the publication
   of the volatile identifier lookup.
4. **Concrete node locks** keyed by semantic node key strings. Transactions acquire the output node
   first and then inputs in canonical order so that two concurrent pulls sharing nodes do not allocate
   or rewrite the same node state at the same time.
5. **Transaction-local state** containing a batch, an overlay identifier lookup, reserved identifiers,
   held node-lock releases, and in-flight nested pull promises.

This is a reasonable lock-based design, but the important observation is that the invariants are not
local to one lock. Correctness depends on the composition of several locks, acquisition-order rules,
and transaction rules:

- node locks protect semantic-node ownership during transaction execution,
- the commit mutex protects disk flush + volatile lookup publication,
- the graph activity mode lock protects migrations and read snapshots from incompatible operations,
- the transaction overlay protects read-your-writes behavior for identifier allocation, and
- nested pulls must reuse the outer transaction rather than reacquiring the graph-level transaction
  boundary.

The result is powerful but fragile. The implementation has to document and test many negative rules:
"do not reacquire this non-reentrant mutex", "do not allocate without holding the node lock", "do not
translate keys in storage", "do not update volatile state before disk", "do not run migration while
pulls observe the old replica", and so on.

## Theoretical model: a logical worker / actor / serializer

A logical worker is a single owner of a mutable state machine. Other code cannot mutate that state
directly; it submits messages to the worker. The worker processes messages one at a time, updates its
private state, performs side effects, and sends a result back to the caller.

This is the same core idea as the actor model. Akka describes actors as independent entities that
react to incoming messages sequentially, one at a time, and says that internal state can be modified
only through messages, eliminating races on actor-owned invariants:
<https://doc.akka.io/docs/akka/current/typed/guide/actors-intro.html>. Microsoft Orleans documents a
similar turn-based model for grains: a scheduler ensures that a grain activation executes on only one
thread at a time, giving the grain single-threaded execution semantics:
<https://learn.microsoft.com/en-us/dotnet/orleans/implementation/scheduler>.

In Node.js this does **not** require a physical `worker_threads` worker. It can be a promise queue in
the same event loop. Node worker threads communicate through message passing and are primarily useful
for CPU-intensive JavaScript, while Node's normal asynchronous I/O is already efficient without worker
threads: <https://nodejs.org/api/worker_threads.html>. MDN's worker docs also emphasize the important
conceptual boundary: messages are copied/transferred rather than direct shared-variable access:
<https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers>.

For this project, "separate logical worker" should therefore mean **a graph-owned serialized command
queue**, not necessarily a separate OS thread. A physical worker thread would add cloning/transfer
costs, complicate capabilities and LevelDB handles, and provide little benefit for an I/O-heavy graph.

## Why this helps

### Centralized synchronization

A worker turns implicit locking into explicit ownership. If the graph worker is the only code allowed
to mutate the identifier lookup, replica pointer, graph sublevels, and graph caches, then ordinary code
no longer needs to coordinate multiple independent locks. There is exactly one serialization point for
state transitions.

Instead of this shape:

```text
public pull
  -> acquire activity mode lock
  -> create transaction
  -> acquire several node locks
  -> compute
  -> acquire commit mutex
  -> flush batch
  -> publish volatile lookup
  -> release all locks in the right order
```

we get this shape:

```text
public pull
  -> send Pull(nodeName, bindings) to graph worker

graph worker loop
  -> dequeue Pull
  -> create transaction from worker-owned committed state
  -> compute using worker-owned transaction context
  -> flush batch
  -> publish worker-owned volatile lookup
  -> resolve caller promise
```

The invariants become state-machine rules instead of lock-order rules.

### Single owner for identifier allocation

Identifier allocation is a natural worker responsibility. The worker can keep the committed lookup,
transaction overlay, and in-flight generated identifiers in one place. `allocateIdentifier(nodeKey)`
can be an internal operation that is called only by the currently executing graph command. That makes
it impossible for two top-level operations to allocate competing identifiers for the same key unless
we intentionally introduce parallel subworkers.

This matches the PR's desired boundary: translate from semantic key to identifier at the graph edge,
then pass identifiers through storage.

### Cleaner disk-before-memory protocol

The worker can enforce one commit sequence for every mutating message:

1. build a batch and identifier-map delta,
2. flush the LevelDB batch,
3. update the worker's committed volatile state,
4. resolve the caller.

If the flush fails, the worker discards the transaction and leaves its committed volatile state
unchanged. Because no other command runs concurrently, there is no observable interleaving between
"disk succeeded" and "memory published".

### Easier replica cutover

Migration and sync pointer swaps are also worker messages. When the worker is executing `Migrate` or
`Sync`, no `Pull`, `Invalidate`, or inspection command can observe the half-swapped state. This removes
the need for a separate exclusive mode lock for graph activity.

### More inspectable concurrency behavior

A message protocol is easier to audit than scattered lock calls. A future reader can inspect the
worker's command union and know every operation that can affect graph state. This fits the project's
preference for explicitness and type-checked JSDoc typedefs.

## Downsides and risks

### Less parallelism

A single worker serializes all graph commands. The current lock-based design tries to allow some
parallelism: multiple pulls can run at the same time if they do not collide on concrete node locks,
and inspections can run in compatible modes. A worker would initially give that up.

For this application that may be acceptable. The graph is part of a personal tool, and correctness and
maintainability are likely more valuable than maximizing parallel graph throughput. Still, if a node
computor performs a long AI call or long filesystem/network operation while the worker is occupied,
every other graph command waits.

This is the biggest design issue. The worker should not blindly hold the queue while doing arbitrary
long external work unless we deliberately accept that latency.

### Reentrancy and nested pulls need careful design

Computors can call `pull` dynamically. If a worker command calls a computor and that computor sends a
new message to the same worker and waits for it, the system deadlocks: the worker cannot process the
nested message until the current message finishes, and the current message cannot finish until the
nested message resolves.

The solution is to make nested pulls **not** enqueue new top-level messages. During a `Pull` command,
the worker should provide the computor with an internal `pullInTransaction` callback bound to the
current transaction. That preserves the existing explicit-context idea and avoids actor self-deadlock.
Public graph APIs enqueue messages; worker-internal nested operations call worker-private functions.

### Long-running command fairness

A large migration or a deep recomputation can monopolize the queue. This is not a data race, but it is
a usability concern. We can address it later with explicit yield points or phased commands, but every
yield point is a place where invariants must be clearly defined. The simplest first implementation
should prefer correctness over cooperative interleaving.

### Back-pressure and cancellation are explicit design work

A queue can grow. In an adversarial web service this would raise rate-limit/back-pressure concerns,
but this project explicitly assumes a non-adversarial client and bans DoS-oriented complexity. Still,
for developer experience, the worker should expose debugging/inspection metrics such as current
command name and queue length. It should not add caps.

Cancellation is also non-trivial. If a caller abandons a promise while a command is running, the
worker must still either finish the commit protocol or discard the transaction safely. The initial
implementation can avoid cancellation support.

### Error handling moves to the protocol boundary

Errors from a worker command resolve/reject the caller promise. The worker must continue processing
subsequent messages after failed commands. This needs explicit error classes close to their sources,
plus a small command-wrapper guarantee: failed command transactions are discarded; the worker loop
itself remains alive.

### Physical worker threads are probably the wrong first step

A real `worker_threads` implementation would force message serialization of command arguments and
results, make capabilities harder to pass, and may not share LevelDB handles safely or pleasantly. It
would also blur project encapsulation by introducing a separate module entry point. Start with an
in-process logical worker. If CPU-bound graph work later blocks the event loop, split specific CPU
computors into physical workers independently of graph-state ownership.

## Suitability for IncrementalGraph

The approach is well-suited to the identifier/persistence problem because the graph already behaves
like a transactional state machine:

- It has a small set of top-level operations (`pull`, `invalidate`, inspect, migrate, sync).
- Correctness depends on ordering disk writes and volatile publication.
- Identifier allocation is stateful and should be centralized.
- Replica swaps are global state transitions.
- Storage should remain identifier-native and not participate in semantic translation.
- Nested pulls already need explicit transaction propagation.

The worker is especially attractive because it can remove the most delicate part of the current PR:
interactions between concrete node locks and commit-time identifier publication. If no two top-level
transactions run at the same time, we do not need per-node allocation locks to avoid same-key races.
The worker can still deduplicate in-flight work within the active command via transaction-local
promises, but it does not need a process-global manual lock map keyed by semantic node strings.

However, the worker is not a free win for recomputation latency. Some computors may perform slow AI or
I/O work. Fully serializing those slow operations means one slow node can delay unrelated graph
queries. There are three possible responses:

1. **Accept full serialization first.** This is simplest and likely correct enough for a personal
   graph. It is the recommended first implementation.
2. **Split compute from commit.** The worker can prepare a transaction, call slow pure/external work
   outside the worker, then send `CommitPreparedTransaction` back. This regains concurrency but brings
   back stale-read/conflict questions. It should be avoided until we have evidence that full
   serialization is too slow.
3. **Shard workers.** One worker per independent graph or per replica/node partition. This restores
   some parallelism but reintroduces cross-worker synchronization for shared identifiers, revdeps, and
   replica swaps. It is not suitable as the first design for PR #1335.

## Recommended design

Implement an in-process `IncrementalGraphWorker` that owns the graph's mutable state and command
queue. It should be a small serializer, not a physical thread.

### Command protocol

A possible command union:

```javascript
/**
 * @typedef {object} PullCommand
 * @property {'pull'} type
 * @property {import('./types').NodeName} nodeName
 * @property {Array<import('./types').ConstValue>} bindings
 */

/**
 * @typedef {object} InvalidateCommand
 * @property {'invalidate'} type
 * @property {import('./types').NodeName} nodeName
 * @property {Array<import('./types').ConstValue>} bindings
 */

/**
 * @typedef {object} InspectCommand
 * @property {'inspect'} type
 * @property {'value' | 'freshness' | 'schemas' | 'materializedNodes'} target
 * @property {unknown} payload
 */

/**
 * @typedef {object} MigrateCommand
 * @property {'migrate'} type
 * @property {Array<import('./types').NodeDef>} nodeDefs
 * @property {(storage: import('./migration_storage').MigrationStorage) => Promise<void>} callback
 */

/**
 * @typedef {PullCommand | InvalidateCommand | InspectCommand | MigrateCommand} GraphCommand
 */
```

The public `IncrementalGraph` methods become thin wrappers that validate public arguments and call
`worker.submit(command)`. The worker loop is the only place that calls mutation internals.

### Worker-owned state

The worker should own or have exclusive access to:

- `RootDatabase`'s active computed replica state,
- committed identifier lookup,
- in-flight generated identifiers,
- concrete instantiation cache, or at least all mutations to it,
- active transaction object while a command runs,
- LevelDB batch commit protocol, and
- migration/sync cutover procedures.

A key design decision: move volatile graph state out of ambient `RootDatabase` mutation methods where
possible. `RootDatabase` can still provide typed database accessors and primitive persistence helpers,
but publication of new volatile state should happen through worker-owned commit functions.

### Nested pull rule

Public `graph.pull(...)` enqueues a `PullCommand`.

Computor-provided `pull(...)` does **not** enqueue. It calls worker-private
`pullInCurrentTransaction(nodeName, bindings, tx)`. If there is no active transaction, it should fail
with a specific internal misuse error. This keeps nested dependency discovery atomic and avoids
self-deadlock.

### Commit rule

Every mutating command should use the same worker-private helper:

```text
runTransaction(commandName, body):
  create tx from committed worker state
  run body(tx)
  if tx has no durable delta: return result
  append identifier map if needed
  flush LevelDB batch
  publish volatile lookup / replica state
  return result
```

No other module should write `identifiers_keys_map` or replace the active lookup.

### Read/inspect rule

There are two acceptable options:

1. Enqueue inspections behind mutations. This gives simple linearizable reads.
2. Allow lock-free reads from an immutable snapshot published by the worker.

For the first implementation, prefer queued inspections. They are simpler, and this application does
not need high-throughput reads.

## What can be deleted or simplified

If the worker fully serializes top-level graph commands, these mechanisms can be removed or reduced:

- concrete node lock map,
- transaction-held node-lock release bookkeeping,
- commit mutex,
- graph activity mode lock for pull/observe/exclusive,
- non-reentrant computed-state mutex warnings, and
- many lock-order tests.

Some external locks may remain outside the graph worker:

- gitstore/checkpoint mutexes, because they protect working-tree state outside IncrementalGraph,
- cross-process synchronization, if added later, because an in-process worker does not serialize other
  Node processes, and
- low-level LevelDB atomic batch behavior, because the worker serializes logical transactions but the
  database still provides durable atomicity.

## Implementation plan

1. **Introduce the serializer without changing semantics.** Add a small queue abstraction with tests:
   FIFO order, rejection propagation, worker survival after a failed command, and no reentrant public
   enqueue from inside a command.
2. **Wrap public graph methods.** Route public `pull`, `invalidate`, migration, sync, and inspection
   through the worker, while leaving existing internals mostly intact.
3. **Move transaction creation/commit into the worker.** Make one helper responsible for identifier
   overlay creation, batch flush, and volatile publication.
4. **Convert nested pulls to worker-private calls.** Ensure computor `pull` callbacks reuse the active
   transaction and never enqueue.
5. **Remove redundant locks gradually.** First remove the commit mutex, then activity-mode locks, then
   concrete node locks after tests prove same-key concurrent pulls share one committed identifier.
6. **Update specs and tests.** Replace lock-order tests with worker-order tests and invariant tests:
   disk-before-memory, exact lookup persistence, migration cutover isolation, failed-command recovery,
   and concurrent public calls producing serializable results.

## Recommendation

Use the logical worker approach as the next design direction for IncrementalGraph, but implement it as
an in-process serialized command queue rather than a physical worker thread.

This approach fits the PR's core goal: keep storage identifier-native and centralize semantic-key to
identifier translation at the IncrementalGraph boundary. It should make the identifier and replica
invariants easier to reason about, reduce lock composition bugs, and align with actor-model theory:
state is owned by one entity and modified only through sequentially processed messages.

The main cost is reduced parallelism, especially if computors perform slow external work. Given the
project's personal-tool context and the complexity already visible in PR #1335, that is an acceptable
first trade-off. If performance becomes a real problem, optimize later from a correct serialized core
rather than trying to preserve parallelism with several interacting locks from the beginning.
