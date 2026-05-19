# PR #1335 Review 1: Strategy

## Design principles
1. **Single source of truth**: keep identifier allocation/persistence derived from one mutable lookup state in migration planning.
2. **Total mapping for outputs**: any key that can appear in output sublevels must be mappable to an output identifier.
3. **Deterministic allocation**: new keys use deterministic-with-collision-retry allocation policy already used elsewhere.
4. **Explicit mode handling**: semantic key input and identifier input paths in pull should be distinguished by shape, not by exception swallowing.
5. **No hidden divergence**: persisted `identifiers_keys_map` should be generated from final lookup after all migration-time allocations.

## Strategy by issue

### A. Allocation fallback for created nodes
- In identifier-native migration planning, replace strict `requireNodeIdentifierForKey` in `keyToOutputKey` with `allocateNodeIdentifier`.
- Use deterministic candidate generator (`deterministicNodeIdentifierFromNodeKey(nodeKey, attempt)`) so behavior is stable.

### B. Persist created mappings
- Ensure `outputEntries` reflects the lookup *after* all `keyToOutputKey` calls during migration shaping.
- Implement `outputEntries` as late/derived serialization from current lookup state rather than fixed snapshot.

### C. Pull path strictness
- Branch by input format:
  - serialized node key (`startsWith('{')`) => deserialize directly.
  - otherwise identifier => resolve via resolver; do not swallow resolver failures.
- Add invariant check that resolver output is serialized node key.

### D. Type precision in lookup API
- Tighten lookup tuple typing to `[NodeIdentifier, NodeKeyString]` for persisted entries so identifier/key roles are not conflated.

## Validation strategy
- Run targeted migration-runner tests.
- Run targeted pull/incremental graph tests.
- Run full test suite, static analysis, build.
