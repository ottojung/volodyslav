# PR #1335 Review 1 Strategy

## Principles
1. Preserve atomic cutover invariants: all state needed by new active replica must be written before pointer switch.
2. Preserve external storage compatibility: decode must accept old on-disk path forms.
3. Preserve type-contract honesty: functions must truly consume declared input type.
4. Keep fixes local and explicit; no hidden behavior changes.

## Strategy
1. **Merge-path consistency fix**
   - In merge flow, read identifier lookup from target replica and host staging replica.
   - Build validated lookups and merge with conflict detection.
   - Persist merged `identifiers_keys_map` in target replica before cutover.
2. **Legacy decode compatibility fix**
   - For non-plain sublevels, accept one-or-more key segments.
   - Decode each segment and join with `/` to recover legacy serialized key path content.
3. **Review-thread correctness fixes**
   - Snapshot reset import: capture previous replica before switching and return actual switch boolean.
   - Pull path: resolve NodeIdentifier -> semantic key via `IdentifierResolver.requireNodeKey` before deserialization.
4. **Validation**
   - Run focused tests around render/sync/pull paths.
   - Run full test + static-analysis + build.
