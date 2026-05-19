# PR #1335 Review Thread 1 — Problem Analysis

## Reviewed thread
Reference: `pullrequestreview-4323287876`.

The feedback reports three correctness problems introduced by the current implementation.

## Problem 1: identifier map write may never persist
In `sync_merge.js`, the code appends `identifiers_keys_map` to `pendingOps` and then calls `flushPendingOps()`. But `flushPendingOps()` only flushes when chunk size threshold is hit.

### Why this is a bug
If the pending count is below chunk size, the identifier map write remains buffered and the function proceeds to revdep unification and replica-pointer update. That can commit merge side effects without committing the merged lookup.

### Impact
- persistence incoherence between node data and identifier map;
- possible lookup misses on later reads;
- latent migration/sync corruption.

## Problem 2: deterministic fallback ignores retry attempt
In `identifier_resolver.js`, `allocateNodeIdentifier` is passed a zero-argument callback. Retry attempts from allocator are ignored.

### Why this is a bug
When deterministic fallback generation is used (e.g., compatibility doubles or missing runtime generator), retries produce the same candidate repeatedly and eventually fail even if a deterministic attempt-dependent candidate could be produced.

### Impact
- avoidable allocation failures in collisions;
- weaker reliability for compatibility/test environments.

## Problem 3: pull path resolves semantic key but does not use it consistently
In `pull.js`, the function resolves an identifier back to semantic key, but still uses the original input for concrete node caching/mutex and later identifier allocation flow.

### Why this is a bug
If input is a persisted identifier, using it as-if semantic key can create/lookup the wrong concrete node and wrong mapping, mixing identifier domain with semantic domain.

### Impact
- incorrect cache keying and mutex scoping;
- accidental remapping/allocation with identifier-as-key;
- subtle recompute or stale-read behavior.

## Root cause theme
All three issues come from **boundary ambiguity** between semantic key domain and identifier domain, plus write ordering assumptions.
