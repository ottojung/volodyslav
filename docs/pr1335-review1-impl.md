# PR #1335 Review 1 Implementation Plan

1. Update `sync_merge.js`
   - Import identifier lookup helpers.
   - In `hasChanges` branch:
     - load host + target `global/identifiers_keys_map`.
     - normalize missing maps to empty lookups.
     - merge lookups with `mergeIdentifierLookups`.
     - write serialized merged map via `T.global.putOp`.
     - flush batch before pointer switch.

2. Update `encoding.js`
   - Keep plain-key sublevel strict single-segment behavior.
   - Change identifier-key sublevel handling to allow multi-segment key content.
   - Decode each segment and reconstruct key content with `/` separators.

3. Update `synchronize_reset_snapshot.js`
   - Capture `previousReplica = database.currentReplicaName()` before set.
   - Return `nextReplica !== previousReplica`.

4. Update `pull.js`
   - Replace direct `deserializeNodeKey(String(nodeKeyStr))` flow with:
     - `nodeKeyIdentifier = identifierResolver.requireNodeKey(nodeKeyStr)`
     - deserialize resolved semantic key.

5. Validation sequence
   - `npm install`
   - focused jest tests for render, sync merge, synchronize reset, pull behavior
   - `npm test`
   - `npm run static-analysis`
   - `npm run build`
