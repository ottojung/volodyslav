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

Validation history is self-describing: certificate basis entries explicitly name semantic input NodeKeys and their ValueIds rather than relying on positional schema ordering.

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

The operation opens one stable `JournalSnapshot`. The source's compatibility decision comes from that snapshot itself:

```text
snapshot.databaseVersion
snapshot.graphSchemeString
```

These are compared exactly with the receiver's active `global/version` and exact persisted `global/graph_scheme` string before source journal records are interpreted/imported.

Ordinary synchronization therefore requires source and receiver to already use one compatible current database/schema representation. It does not migrate or convert individual journal records on the fly.

A caller or transport may have separately observed source metadata earlier, but Journal 3 synchronization does not rely on that earlier mutable observation. If the source migrated before `openSnapshot()`, the held snapshot's compatibility metadata governs the operation.

After a successful pairwise synchronization:

- the compatibility metadata and imported journal history came from one stable source snapshot;
- the receiver retains every compatible source historical record through the captured source frontier;
- any required receiver normalization history is committed;
- the active graph equals replay of the active journal;
- no computor was invoked;
- source payloads are taken from ValueEvents, not recomputed;
- repeating against the same unchanged already-incorporated source is a semantic no-op.

Synchronization may observably change:

- cached values;
- selected physical NodeIdentifiers;
- materialization presence;
- freshness;
- validity/proof state.

These changes arise from replayed/normalized history, not from running application computors.

### Synchronization normalization is durable history

A synchronization may itself create a real graph transition required by the ordinary IncrementalGraph contract, for example:

- deleting a cached dependent whose required input is now absent; or
- persistently marking the **selected current cached occurrence** stale when its own certificate exactly matches the selected input ValueIds but a direct input is stale.

The second case applies even when synchronization has just selected a new remote ValueId for the dependent. It is not limited to dependents whose ValueId was already selected on the receiver.

For example, with `A -> B`, if the receiver has stale `A=a1` and the source contributes fresh `B=b2` validated exactly against `A=a1`, the synchronized receiver selects `b2` but must persistently invalidate that `b2` occurrence. If A later becomes fresh through `Unchanged` without changing its ValueId, B remains stale until B itself is pulled/revalidated/recomputed.

Those transitions are committed as ordinary receiver-authored Journal 3 events. They are not temporary acknowledgements or merge scratch metadata.

If previously unseen concurrent history is learned later, normal Journal 3 replay may change the current graph again, but an already committed normalization event is not retroactively erased from history merely because a different source-observation order could have avoided authoring it.

Consequently the convergence promise is about the **actual execution**: once non-normalization graph-changing activity stops, fair synchronization eventually finishes the finite remaining normalization consequences, disseminates all actually authored records, and makes participating replicas observably equivalent. Journal 3 does not promise that counterfactual executions which really authored different normalization histories would have identical final states.

## Synchronization failure

A failed source synchronization does not expose a half-imported active state.

The previously active journal/projection pair remains supported if failure occurs before cutover.

An outer operation processing multiple sources may have committed earlier sources before a later source fails; callers must not assume all-source rollback unless the outer API explicitly promises it.

Failures distinguish incompatibility, writer fork/corruption, malformed history, projection failure, and ordinary publication/I/O failure sufficiently for lifecycle code to respond appropriately.

A snapshot database-version or exact graph-scheme mismatch is a `JournalVersionCompatibilityError` / migrate-first incompatibility rather than permission for synchronization to upcast/downcast records.

## Same-writer restoration

A controlled installation which has an exact prefix of its own writer history may recover a longer exact suffix at the same compatible current database version/schema.

After successful recovery:

- the restored writer history is retained exactly in the current representation;
- graph state is replayed from it;
- local allocator/writer state is restored before new allocation;
- new local events continue after the recovered head;
- no synthetic reset is required solely because history was temporarily missing locally.

If overlapping same-writer records disagree, recovery fails rather than choosing one branch.

## Reset

Conceptually:

```text
resetTo(source)
```

requests the source's projected graph state relative to all history reset currently observes.

Reset uses one held `JournalSnapshot`. Its exact `databaseVersion` and `graphSchemeString` must match the receiver's active metadata, and that same snapshot supplies the source journal and target projection. Reset does not accept an independently checked earlier compatibility result if the source may have changed before snapshot acquisition.

After success:

- old receiver history is still retained;
- compatible-version source history is retained/imported;
- a new local reset baseline establishes source-equivalent payload/timestamp/freshness/validity semantics;
- current ValueIds may differ from the source because reset authors new baseline occurrences;
- the operation is atomic;
- no computor ran.

Reset does not promise to dominate an unseen concurrent event from a third replica forever. If such history is learned later, ordinary synchronization conflict semantics apply.

Repeated reset to an unchanged target which is already satisfied may report no change without appending redundant semantic history.

## Startup/migration

A Journal-3-aware application does not expose an initialized graph until required version migration/bootstrap and journal/projection validation succeed.

The active replica has one persisted representation selected by its existing `global/version`. Journal records do not carry independent format versions, and normal startup/replay does not maintain a mixture of old/new journal formats or invoke per-record upcasters.

Initial conversion from a supported pre-Journal-3 database records a replay baseline directly in the target current format equivalent to the legacy graph.

For a later Journal-3-aware database-version migration:

1. the old active replica remains in its source format while an inactive target is built;
2. every retained journal record is deterministically rewritten into the target version's canonical representation while preserving its `JournalRecordId`, historical semantic fact, causal identity, and references;
3. semantic graph/schema changes are recorded separately by a new migration baseline;
4. the target graph/journal pair is verified; and
5. cutover is atomic.

After cutover the target contains only the target current representation. Future startup/replay neither decodes the old record format nor reruns historical migration callbacks merely to reconstruct current state.

Because representation migration may touch every retained record, migration time and I/O may grow with the complete journal. That cost is an accepted trade-off for keeping the database single-format; implementations should still stream the rewrite where practical rather than requiring the complete journal in RAM.

Historical validation certificates remain semantically intelligible because they explicitly identify the semantic input NodeKeys they referred to. Their representation is rewritten into the target current format during migration, while current replay only uses a certificate as current proof when its input-key set matches the current schema.

## Projection rebuild

An administrative projection rebuild may reconstruct graph/index state from authoritative journal history.

For valid history, successful rebuild is semantically invisible to application callers: the rebuilt graph is equivalent to the graph the journal already determines.

If authoritative history itself is malformed/forked, rebuild fails rather than changing history to match damaged graph bytes.

Projection rebuild does not rewrite journal record format; representation changes belong to the explicit database-version migration path.

## No journal-compaction maintenance expectation

Journal 3 has no user-visible hourly/periodic destructive compaction obligation.

A caller does not need to ensure that old peers acknowledge history before old historical facts remain correct. Authoritative replay history is retained.

Derived maintenance such as checkpoints/index rebuilding may be introduced independently and must not change semantic history.
