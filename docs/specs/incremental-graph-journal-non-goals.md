# IncrementalGraph Journal 3 Non-Goals

Journal 3 specifies replayable local history and semantic synchronization. The following are intentionally outside the current design unless another normative document explicitly takes ownership of them.

## Concrete remote/backend protocol

Journal 3 does not currently specify:

- Supabase tables;
- PostgreSQL schema/RPCs;
- HTTP endpoints;
- authentication/authorization;
- remote blob layout;
- remote garbage collection;
- backend deployment topology.

The journal synchronization semantics depend only on a stable `JournalSyncSource`/`JournalSnapshot` abstraction.

## Destructive compaction

Journal 3 does not specify deletion of old authoritative replay records.

Checkpoints, indexes, compression, archival, and physical payload deduplication may be added only if logical immutable history remains recoverable with the same replay meaning.

## Public journal mutation

Journal 3 does not make raw event append/frontier editing an application API.

Application callers continue to mutate graph state through supported IncrementalGraph/domain operations.

## Byzantine consensus/security

Supported replicas are assumed non-adversarial.

Journal 3 detects observable forks/malformed records but does not currently provide cryptographic signatures, Byzantine consensus, or malicious-replica conflict resolution.

## Exact change-sensitive synchronization complexity

Journal 3 requires streamability of journal suffix transfer and appropriate derived indexes, but issue #1607 owns the future end-to-end time-complexity guarantee.

Correctness specs may currently permit whole-replica work where needed.

## Arbitrary historical-time graph checkout

Core replay guarantees reconstruction of the current supported graph under the current compatible interpretation.

A future diagnostic feature may reconstruct old cuts for debugging, but arbitrary historical checkout may additionally require historical schema/version artifacts and is not required by the current public graph API.

## Event-log user interface

The retained history is intentionally useful for debugging, but Journal 3 does not currently specify a UI/CLI for browsing operations/events.

Such tooling should be read-only with respect to authoritative records.

## Cross-version ordinary synchronization

Ordinary Journal 3 sync does not silently migrate peers.

Replicas must reach a compatible current version/schema via supported migration before ordinary semantic synchronization.

## Operation grouping

High-level operation records/grouping are useful future debugging metadata, but core replay is intentionally defined entirely by low-level semantic events plus writer-state records.

Operation grouping may be added later without becoming necessary authority for current graph reconstruction.
