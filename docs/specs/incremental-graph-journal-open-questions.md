# Journal 3 Open Specification Questions

This document lists current design questions which are **not yet normative requirements**. It exists so implementers do not accidentally treat underspecified areas as settled.

## Checkpoint persisted format

Journal 3 permits replay checkpoints as derived acceleration, but no persisted checkpoint schema/validation protocol is specified yet.

Correctness does not depend on checkpoints; implementation may begin without them.

## High-level operation grouping

Core replay is fully defined by low-level events. A future debugging layer may group events by pull/sync/reset/migration operation.

Open choices include whether operation grouping consumes writer-stream coordinates or lives in a separate diagnostic index.

It must not become necessary authority for replay.

## Historical-cut replay across old schemas

Current-state replay after migration is specified. Reconstructing an arbitrary historical graph cut from before schema migration may require historical schema artifacts.

This is not currently required for normal restore/synchronization, but may be useful debugging tooling later.

## Optimized incremental projection indexes

The semantic replay model is defined. Production may maintain per-node current-head/certificate/reverse-edge indexes to avoid whole-history scans.

Exact persistent/index layout and rebuild policy remain implementation choices so long as indexes are derived and replay-equivalent.

Issue #1607 owns the future end-to-end synchronization time bound.

## Physical payload deduplication

ValueEvent logically owns its immutable payload. A future storage layer may deduplicate large equal/content-addressed payload bytes physically.

Any such design must preserve the logical guarantee that every historical ValueEvent remains independently replayable even if another occurrence is deleted from derived state.

## Read-only history inspection API

The replay log is intentionally useful for diagnostics, but exact CLI/HTTP/JavaScript user-facing history browsing is not yet specified.

If added, it should expose immutable records/read models without raw mutation capability.
