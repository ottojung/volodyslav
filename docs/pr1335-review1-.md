# PR #1335 Review 1: Problem Analysis

This document analyzes the review feedback thread at:
- https://github.com/ottojung/volodyslav/pull/1335#pullrequestreview-4323634184

And the two P1 follow-up findings provided.

## Problem A (P1): create-decisions fail under identifier-native prior DB

## Symptom
During migration, `storage.create(nodeKey, value)` can fail before cutover when the active database already has `identifiers_keys_map`.

## Root cause
In the identifier-native branch of migration key planning:
- `keyToOutputKey(nodeKey)` previously called `requireNodeIdentifierForKey(lookup, nodeKey)`.
- For newly created semantic keys, no entry exists yet in old lookup.
- That throws `Missing node identifier for key ...`.

So migration cannot allocate output identifiers for newly introduced nodes.

## Required correctness property
`keyToOutputKey` must be total on all migration decision keys that survive output, not only keys that pre-existed in prior lookup.

---

## Problem B (P1): mapping persistence misses create-decisions

## Symptom
Migration can write records for created nodes under fresh identifiers in sublevels, but fail to persist corresponding identifier<->key entries in `identifiers_keys_map`.

## Root cause
The emitted `identifiers_keys_map` was built from pre-existing/materialized key sets only. Created outputs were addressable during this run but not included in final persisted map.

## Consequence
Next runtime pass cannot resolve those newly written identifier keys through lookup, and may allocate different identifiers for the same semantic keys.

## Required correctness property
Persisted identifier map must include every non-deleted output node after migration, especially created nodes.

---

## Additional thread feedback: pull-path fallback quality

In `pull.js`, error swallowing around `requireNodeKey` can mask missing-lookup corruption and emit misleading deserialization errors.

Expected behavior:
- If caller passes serialized semantic key (`{"head":...}`), parse directly.
- If caller passes opaque identifier, resolve through lookup and propagate mapping errors clearly.
- Avoid broad catch that conflates these cases.
