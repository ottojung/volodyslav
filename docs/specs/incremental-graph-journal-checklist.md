# IncrementalGraph Journal 3 Implementation Checklist

## Purpose

This checklist translates the normative Journal 3 specifications into implementation milestones and acceptance checks.

It is not a second design. Each item points at behavior defined elsewhere; implementation details may vary as long as the normative result is preserved.

## 1. Persisted journal primitives

Implement durable current-version representations for:

- `JournalRecordId { author, sequence }`;
- `JournalFrontier`;
- `AuthorityTime`;
- `ValueEvent`;
- `DeleteEvent`;
- `ValidateEvent`;
- `InvalidateEvent`;
- `WriterStateRecord`.

Acceptance:

- the replica's existing `global/version` is the only persisted format-version selector;
- journal records contain no per-record version discriminator;
- one writer range can be iterated in sequence order;
- current-format records round-trip exactly through the codec;
- malformed current-format bodies are rejected with specific errors;
- validation bases are self-describing, duplicate-free, and ordered by canonical persisted `NodeKeyString` order;
- no public API permits arbitrary journal mutation.

## 2. Journal snapshot

Implement the semantic `JournalSnapshot` abstraction.

Acceptance:

- snapshot carries exact `databaseVersion` from source `global/version`;
- snapshot carries exact `graphSchemeString` from source `global/graph_scheme`;
- compatibility metadata, local writer identity, frontier, and records all belong to one immutable committed source state;
- snapshot compatibility metadata/frontier are immutable for its lifetime;
- `get(A,q)` and ordered range iteration observe one fixed retained prefix;
- range iteration detects/does not silently skip holes;
- a migration/cutover between an earlier external metadata read and `openSnapshot()` cannot cause stale compatibility metadata to be reused; sync/reset always compare metadata from the held snapshot itself;
- snapshot reads have no graph side effects.

## 3. Local publication finalization

Integrate journal finalization with the existing graph darkroom/transaction publication boundary.

Acceptance:

- failed transactions leave no durable journal sequence hole;
- concurrent successful transactions receive disjoint contiguous writer ranges in commit order;
- same-publication ValueId references resolve only after final IDs are allocated;
- exact validation bases are rebuilt/confirmed from finalized current inputs at commit time;
- graph+journal commit atomically;
- volatile journal allocator caches publish only after durable success.

## 4. Ordinary graph emission

Implement each case from `incremental-graph-journal-emission.md`.

Acceptance tests cover:

- fresh pull no-op;
- first materialization;
- changed recomputation;
- `Unchanged`;
- cache revalidation;
- explicit invalidation;
- transitive propagated invalidation;
- materialization deletion/removal;
- `last_node_index` advancement.

For each committed case assert:

```text
project(journalAfter) == graphAfter
```

## 5. Replay engine

Implement a clear reference replay path before/alongside incremental optimization.

Acceptance:

- value/delete head selection is deterministic;
- reference-causality rules are enforced;
- retained certificate records are understood from explicit input NodeKeys without historical positional schema ordering;
- current certificate shape compatibility/selection is deterministic;
- freshness/validity exactly match the flag-based graph contract;
- physical identifiers/timestamps/payloads come from selected ValueEvents;
- local writer watermark comes from local WriterStateRecords;
- full rebuild from journal yields valid existing graph storage.

Keep the reference replay path simple enough to serve as a test oracle even if production later maintains projections incrementally.

## 6. Bootstrap migration

Implement pre-Journal-3 bootstrap directly into the target current database format.

Acceptance:

- all existing materialized values/payloads/timestamps/identifiers are represented;
- stale nodes with partial validity use the controlled `"unknown"` basis value correctly;
- bootstrap basis entries explicitly name every direct input and use canonical NodeKeyString order;
- bootstrap authority allocation follows the modifiedAt-preserving special rule;
- replayed graph equals the legacy graph exactly;
- local allocation watermark is preserved;
- cutover is atomic.

## 7. Pairwise synchronization

Implement synchronization against one `JournalSyncSource`/stable snapshot.

Acceptance:

- source snapshot's exact `databaseVersion` and `graphSchemeString` are compared with receiver active metadata before source journal interpretation/import;
- that compatibility metadata belongs to the same snapshot as the source frontier/records;
- version/schema mismatch raises `JournalVersionCompatibilityError` rather than implicit migration;
- imports every missing writer suffix, not only source-local writer history;
- verifies overlapping IDs;
- supports exact same-writer prefix recovery;
- rejects same-writer fork;
- import is streamable;
- no computor execution;
- imported records retain exact writer/ID/body;
- no per-record upcast/downcast occurs during sync;
- no receipt/adoption event is created merely for transport.

## 8. Synchronization normalization

Implement both normalization phases.

Acceptance:

- dependency-closure removal authors explicit sync DeleteEvents;
- cause-before-dependent delete ordering is deterministic;
- every selected current occurrence whose own proof exactly matches current inputs but is stale solely because a direct input is stale gets/retains a persistent current-value sync invalidation;
- that rule applies even when synchronization **changes** the selected ValueId or newly materializes/selects a remote occurrence;
- the regression `A -> B`: receiver A stale, source supplies fresh remote B based on same A ValueId, then receiver A revalidates `Unchanged` => B remains stale until B itself is pulled;
- basis-mismatch or already-uncovered-invalidated nodes do not receive unnecessary duplicate markers;
- repeated sync does not create duplicate stale-transition events;
- repeat synchronization against unchanged source is a semantic no-op;
- after non-normalization changes stop, generated sync normalization reaches a finite fixed point under fair dissemination;
- tests do not incorrectly require counterfactual source schedules which authored different normalization events to have identical final histories.

## 9. Reset

Implement `resetTo` semantics under exclusive maintenance.

Acceptance:

- source target is derived from one held `JournalSnapshot`;
- exact source snapshot `databaseVersion`/`graphSchemeString` match receiver active metadata before import/baseline authoring;
- compatibility metadata and source journal belong to the same snapshot cut;
- source history is retained/imported first;
- old receiver history remains retained;
- source-present target nodes receive new reset ValueIds;
- source validity/freshness are rebaselined exactly;
- reset certificate basis keys equal target direct-input keys and are canonically ordered;
- receiver-local allocator watermark remains local;
- replayed result is observationally equal to source target;
- repeated reset to already-equal unchanged target may no-op.

## 10. Journal-aware migration

Implement whole-database Journal-3-aware migration.

Acceptance:

- the source active replica remains entirely in source format until cutover;
- every retained source journal record is rewritten into the target canonical format in inactive storage;
- rewritten pre-existing records preserve `(author,sequence)`, causal/reference identity, and historical semantic meaning;
- rewriting the same source record independently produces the same target-format body;
- the target contains no mixture of source/target record formats and no per-record version tags;
- target-present nodes receive new migration occurrences for semantic target state;
- removed current nodes receive migration DeleteEvents;
- target validity/freshness are reproduced by baseline certificate + optional invalidation;
- target certificate input-key sets match target schema and use canonical NodeKeyString ordering;
- historical old-schema certificates remain semantically self-describing after representation rewrite;
- target schema replay equals migration target;
- replay never reruns historical migration callbacks;
- migration may stream across/rewrite the complete retained journal; time/I/O proportional to journal size is accepted.

## 11. Open/rebuild lifecycle

Implement current-state validation/rebuild boundaries.

Acceptance:

- startup interprets the complete active replica using its one `global/version` format;
- startup does not expose known graph/journal disagreement;
- valid journal + damaged derived graph can be rebuilt;
- invalid/forked authoritative journal is rejected rather than "repaired" from graph bytes;
- allocator/high-water/index caches can be reconstructed from authoritative history.

## 12. Error model

Provide specific errors/values sufficient to distinguish:

- writer fork;
- stream gap;
- causal-closure/reference-causality violation;
- current-format record codec/self-described-basis violation;
- snapshot database-version / exact graph-scheme incompatibility;
- projection invariant failure;
- durable publication/I/O failure.

Do not collapse all journal failures into generic corruption or generic sync failure when the caller can act differently based on category.

## 13. Reference model / property verification

Before relying on optimized incremental projection/synchronization, implement tests or a bounded model against `incremental-graph-journal-theorems.md`.

Priority properties:

- deterministic replay under writer interleavings;
- causality -> authority;
- prefix-union algebra;
- local emission preservation;
- certificate soundness;
- snapshot-bound compatibility checking;
- persistent stale propagation for newly selected remote occurrences;
- repeat-sync no-op;
- normalization fixed-point/termination for each actual fair execution;
- reset target theorem;
- bootstrap equivalence;
- migration equivalence;
- deterministic whole-journal format migration.

## 14. Performance work deferred, not forgotten

Issue #1607 owns end-to-end change-sensitive synchronization complexity.

The first correct implementation may perform whole-graph work where the current specification permits it, but should keep these boundaries amenable to later optimization:

- ordered journal suffix reads;
- derived reverse structural-edge index;
- incremental current-head/certificate indexes;
- inactive/staged target publication;
- reference replay separate from optimized projection maintenance.

Separately, repository intent explicitly accepts whole-journal work for a format-changing database migration. Do not weaken the one-format invariant merely to make migrations change-sensitive.

Correctness must not be weakened to meet an unstated performance target.

## 15. Completion condition

Journal 3 is implementation-complete only when ordinary operations, synchronization, reset, migration, restart/open, and projection rebuild all preserve:

```text
persistedGraph == project(retainedJournal)
```

and when every supported active replica contains only its current `global/version` representation, sync/reset compatibility is established from one held source snapshot, and the tests cover the proof obligations relevant to each path.
