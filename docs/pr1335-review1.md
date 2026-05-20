# PR #1335 review feedback #1: semantic keys parsed as node identifiers

## Feedback summary
The review points out a correctness bug in `reconcileHostLookupWithTargetLookup`:

- The function iterates `targetLookup.keyToId`, where the map key is a **semantic node key string**.
- It then passes that semantic string to `nodeIdentifierFromString(...)`.
- `nodeIdentifierFromString` only accepts 9-letter identifier strings.

When replicas independently allocate different identifiers for the same semantic node key (which is expected in distributed sync), this path tries to parse semantic data as an identifier and throws `InvalidNodeIdentifierError`.

## Exact problematic area
File: `backend/src/generators/incremental_graph/database/reconcile_identifier_lookup.js`

Current problematic behavior (before fix):

- Detect conflicting mapping for the same semantic key between target and host.
- Remove host-side stale mapping.
- Reinsert mapping with target identifier, but compute node key as `nodeIdentifierFromString(nodeKeyString)`.

This conversion is invalid when `nodeKeyString` is something like serialized semantic JSON (for example `{"head":"...","args":[]}`), and should never be interpreted as an opaque identifier token.

## Why this is a P1
This is a sync-blocking correctness issue:

- It triggers in normal divergence scenarios (independent allocations).
- It aborts merge flow in `mergeHostIntoReplica` instead of reconciling.
- It violates the architectural principle introduced by #1335: semantic key representation must not be confused with identifier representation.

## Root cause
Representation boundary breach:

- `keyToId` keys are semantic keys.
- `nodeIdentifierFromString` parses opaque identifiers.
- Reconciliation code accidentally treats semantic-key text as identifier text.

## Correctness requirement
Reconciliation must use the already-typed `NodeIdentifier` node-key value from the lookup structures (`idToKey` or prior mapping lookups), not reparse semantic strings through identifier parsers.
