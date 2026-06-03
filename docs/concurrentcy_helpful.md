
## 1. Safety: “nothing bad happens”

These are invariants that must always hold.

**Data-race freedom**
Two threads should not access the same mutable memory concurrently where at least one access is a write, unless the access is synchronized or atomic.

Example danger:

```c
x = x + 1;
```

Two threads can both read the same old value and lose one increment.

**Atomicity**
Some operations need to happen as one indivisible logical step, even if implemented by many machine instructions.

Example:

```text
check balance >= amount
subtract amount
record transaction
```

If another thread observes the state halfway through, the program may violate its invariants.

**Invariant preservation**
Locks are often best understood as protecting invariants, not variables.

For example:

```text
queue.length == number of nodes reachable from queue.head
```

The lock protects the relationship between `length`, `head`, and the nodes.

**Visibility / memory ordering**
One thread’s writes must become visible to another thread at the right time. This is where memory models, atomics, acquire/release, volatile-like constructs, and happens-before relations matter.

Classic bug:

```text
Thread A:
  data = compute()
  ready = true

Thread B:
  if ready:
      use(data)
```

Without synchronization, Thread B may see `ready = true` but stale or partially visible `data`.

**Linearizability / consistency of concurrent objects**
If you implement a concurrent queue/map/cache/etc., each operation should appear to happen at one instant between call and return. This is stronger than “no crashes”; it means clients can reason about it as if operations were interleaved sequentially.

---

## 2. Liveness: “something good eventually happens”

This is where your examples fit.

**Deadlock freedom**
The program should not reach a state where threads wait forever for each other.

Classic:

```text
Thread 1: holds A, waits for B
Thread 2: holds B, waits for A
```

Common prevention: impose a global lock acquisition order.

```text
Always acquire A before B.
Never B before A.
```

**Starvation freedom**
A thread should not be postponed forever while others keep making progress.

Example: a writer waits forever because readers continuously acquire a read lock.

**Livelock freedom**
Threads are not blocked, but they keep reacting to each other and make no useful progress.

Example: two polite workers both repeatedly step aside for each other.

**Fairness**
If a thread repeatedly asks for a resource, does it eventually get it? Different locks, schedulers, queues, and runtimes have different fairness guarantees.

**Bounded waiting**
A stronger version of starvation freedom: not only does a thread eventually proceed, but it proceeds within some bounded number of turns/events.

**Progress guarantees**
Especially for lock-free algorithms:

```text
blocking       — progress may require another thread to run
deadlock-free  — some thread always makes progress
starvation-free — every waiting thread eventually progresses
lock-free      — system as a whole makes progress
wait-free      — each operation finishes in bounded steps
```

Wait-free is strongest; blocking with mutexes is often simplest and perfectly fine.

---


## 4. Resource management

A lot of concurrency bugs are really resource bugs.

**Lock ordering**
Have a global policy: “locks are acquired in this order.” This prevents many deadlocks.

**Lock granularity**
Coarse locks are simpler but reduce parallelism. Fine-grained locks improve concurrency but increase complexity and deadlock risk.

**Critical section size**
Keep locked regions small, but not so small that invariants become hard to reason about.

Bad:

```text
lock
do slow I/O
do network request
unlock
```

Usually avoid holding locks during I/O, callbacks, logging, or user-provided code.

**Cancellation and shutdown**
How do threads stop? What happens if one is waiting? Who owns cleanup? Can a task be interrupted halfway through an invariant update?

**Timeouts**
Timeouts can prevent permanent waits, but they do not automatically make the program correct. They often turn deadlocks into partial failures that still need handling.

**Backpressure**
If producers are faster than consumers, queues grow forever unless you bound them or slow producers down.

---

## 5. Performance issues

A correct multithreaded program can still be slower than a single-threaded one.

**Contention**
Too many threads competing for the same lock/atomic/cache line.

**False sharing**
Different threads modify different variables, but those variables live on the same cache line, causing cache invalidation traffic.

**Oversubscription**
More runnable threads than CPU cores can lead to context-switch overhead.

**Load balancing**
Some threads may finish early while others do all the work.

**Amdahl’s law**
A small sequential part can dominate total runtime improvement.

**Priority inversion**
A high-priority thread waits for a low-priority thread holding a lock, while medium-priority threads keep preempting the low-priority one.

---

## 6. Reasoning and design discipline

The most important conceptual advice: **minimize shared mutable state**.

Good questions to ask:

```text
What data is shared?
Who owns it?
What invariant must hold?
Which lock/atomic/protocol protects that invariant?
Can a thread observe an intermediate state?
What are the allowed state transitions?
Can every wait eventually be satisfied?
What happens during shutdown or failure?
```

For each shared object, it helps to write a tiny “concurrency contract”:

```text
Protected by: mutex M
Invariant: size == number of nodes
Methods safe to call concurrently: push, pop
Callbacks while holding lock: none
Blocking behavior: pop waits until non-empty or closed
Shutdown behavior: close wakes all waiters
```

---
