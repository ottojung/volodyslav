# PR 1335 Review 1 Strategy

## Principle

Keep PR 1335's disk-first volatile/persistent invariant, but remove the broad transaction-body mutex. Correctness should come from precise ownership and merge boundaries rather than from serializing all work.

The strategy is to split transaction coordination into three layers:

1. graph activity modes continue to separate pull, observe, and exclusive maintenance phases;
2. per-node pull locks protect concrete node computation and stay held through commit/abort;
3. a short commit mutex serializes rebase, raw-operation rendering, durable flush, volatile publication, and reservation cleanup.

Identifier allocation must remain deterministic and auditable. New identifiers are synchronously reserved in root computed state before they enter a transaction overlay. This reservation is not durable and is cleared on abort; it exists only to prevent two live transactions in one process from holding the same generated identifier.

## Transaction model

Transactions should record logical intents instead of eagerly recording every raw database operation. Eager raw operations are safe for node-owned records when a node lock protects the owner, but shared records such as reverse dependencies require merge-at-commit semantics. Therefore the implementation should use an intent-backed read-your-writes batch facade and render raw operations under the commit mutex.

Identifier overlays should be rebased during commit. If another transaction already committed the same node key, the later transaction adopts the committed identifier as canonical and rewrites its intents accordingly. If the key is still uncommitted, the transaction validates its reservation and writes the merged full lookup to disk in the same batch as node-state changes.

## Concurrency discipline

Top-level pulls acquire pull mode, then acquire per-node locks as concrete nodes are traversed. Nested pulls reuse the same transaction and only acquire additional dependency locks. Locks are released only after commit or abort so no second transaction can compute the same node against private, not-yet-durable writes.

Disjoint nodes may compute concurrently. Shared dependencies serialize at the dependency lock only. Invalidations remain observe-mode and may run concurrently with each other; their writes are idempotent and identifier conflicts converge during commit rebase.

## Non-goals

This strategy does not implement multi-process writer safety. The synchronous reservation guarantee relies on one Node.js event loop and one active writer process per replica, as stated in the design. A multi-process deployment would require durable reservation rows with transactional uniqueness.
