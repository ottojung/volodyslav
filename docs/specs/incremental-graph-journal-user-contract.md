# Journal 3 User-Visible Operation Contract

## Purpose

Journal 3 is primarily persistence/synchronization infrastructure, but it changes what callers can rely on after lifecycle operations.

This document collects those observable expectations without exposing raw journal internals as application APIs.

## Ordinary graph APIs remain the application interface

Application code continues to use the ordinary IncrementalGraph operations defined elsewhere, principally:

```text
pull(nodeName, bindings?)
invalidate(nodeName, bindings?)
inspection/read operations
```

Application code does not need to supply journal IDs, causal contexts, HLC coordinates, writer identities, or ValueIds.

## `pull()`

A successful `pull()` returns the same semantic result required by the ordinary IncrementalGraph contract.

Journal 3 adds this durability expectation:

> if the pull changes persisted graph state, the replay-complete journal history describing that state is already committed atomically before success is observable.

Possible cases include:

- already-fresh fast path: no persisted semantic change, therefore no semantic journal event required;
- first materialization: value + validation history is committed;
- changed recomputation: new value occurrence + validation + actual propagated stale transitions are committed;
- `Unchanged`: existing ValueId is preserved and a validation is committed when required;
- cache revalidation: existing ValueId is preserved and stale->fresh proof is committed.

A caller does not observe a successful new graph value whose journal history failed to commit.

## `invalidate()`

A successful explicit invalidation does not execute the target computor.

It commits replay history sufficient to reproduce:

- target staleness/direct proof invalidation; and
- every actual propagated fresh->stale transition required by the current graph state.

The target's cached payload normally remains available as `oldValue` for a future pull according to the ordinary graph contract.

## Inspection/read APIs

Read-only graph inspection observes the current materialized projection.

It does not invoke computors merely to make the graph fresh and does not append semantic journal history merely because a value was inspected.

A diagnostic journal-history viewer may be added separately, but is not part of ordinary graph computation APIs.

## Synchronization

Conceptually:

```text
synchronizeFrom(source)
```

is an administrative operation, not a computor call.

After a successful pairwise synchronization:

- the receiver retains every compatible immutable source record through the captured source frontier;
- any required receiver normalization history is committed;
- the active graph equals replay of the active journal;
- no computor was invoked;
- source payloads are taken from immutable ValueEvents, not recomputed;
- repeating against the same unchanged already-incorporated source is a semantic no-op.

Synchronization may observably change:

- cached values;
- selected physical NodeIdentifiers;
- materialization presence;
- freshness;
- validity/proof state.

These changes arise from replayed/normalized history, not from running application computors.

## Synchronization failure

A failed source synchronization does not expose a half-imported active state.

The previously active journal/projection pair remains supported if failure occurs before cutover.

An outer operation processing multiple sources may have committed earlier sources before a later source fails; callers must not assume all-source rollback unless the outer API explicitly promises it.

Failures distinguish incompatibility, writer fork/corruption, malformed history, projection failure, and ordinary publication/I/O failure sufficiently for lifecycle code to respond appropriately.

## Same-writer restoration

A controlled installation which has an exact prefix of its own writer history may recover a longer exact suffix.

After successful recovery:

- the restored writer history is retained verbatim;
- graph state is replayed from it;
- new local events continue after the recovered head;
- no synthetic reset is required solely because history was temporarily missing locally.

If overlapping same-writer records disagree, recovery fails rather than choosing one branch.

## Reset

Conceptually:

```text
resetTo(source)
```

requests the source's projected graph state relative to all history reset currently observes.

After success:

- old receiver history is still retained;
- source history is retained/imported;
- a new local reset baseline establishes source-equivalent payload/timestamp/freshness/validity semantics;
- current ValueIds may differ from the source because reset authors new baseline occurrences;
- the operation is atomic;
- no computor ran.

Reset does not promise to dominate an unseen concurrent event from a third replica forever. If such history is learned later, ordinary synchronization conflict semantics apply.

Repeated reset to an unchanged target which is already satisfied may report no change without appending redundant semantic history.

## Startup/migration

A Journal-3-aware application does not expose an initialized graph until required version migration/bootstrap and journal/projection validation succeed.

Initial conversion from a supported pre-Journal-3 database records a replay baseline equivalent to the legacy graph.

Later migrations retain old history and record their settled target result. Future startup/replay does not rerun historical migration callbacks merely to reconstruct current state.

## Projection rebuild

An administrative projection rebuild may reconstruct graph/index state from authoritative journal history.

For valid history, successful rebuild is semantically invisible to application callers: the rebuilt graph is equivalent to the graph the journal already determines.

If authoritative history itself is malformed/forked, rebuild fails rather than changing history to match damaged graph bytes.

## No journal-compaction maintenance expectation

Journal 3 has no user-visible hourly/periodic destructive compaction obligation.

A caller does not need to ensure that old peers acknowledge history before old records remain correct. Authoritative replay records are retained.

Derived maintenance such as checkpoints/index rebuilding may be introduced independently and must not change semantic history.
