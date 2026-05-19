# PR #1335 Review Feedback #1: Problem Analysis

## Feedback summary
The review requests refactoring `root_database.js` so replica-switching state is **atomic and single-sourced**.

## Core problem
Current `RootDatabase` behavior spreads active and inactive replica state across many mutable fields:

- `_cachedValueOfCurrentReplica`
- `_xNamespaceSublevel` / `_yNamespaceSublevel`
- `_xGlobalSublevel` / `_yGlobalSublevel`
- `_xSchemaStorage` / `_ySchemaStorage`
- `_identifierLookup`

This creates multiple mutation surfaces and can lead to drift between fields that are conceptually one runtime state.

## Why non-atomicity is dangerous
On switch operations, some values can be prepared or updated at different times. Even when this is usually correct, the shape itself allows inconsistent intermediate states in memory if an error occurs at the wrong point.

The review wants a strong invariant:

- Build candidate state fully first.
- Persist pointer.
- Commit one assignment to live runtime state.

## Architectural requirement from the review
The object should keep only these durable fields:

- `db`
- `_rootMetaSublevel`
- `version`
- `_seed`
- `_computed`

Where `_computed` is the only mutable active bundle:

- `replicaName`
- `namespaceSublevel`
- `globalSublevel`
- `schemaStorage`
- `identifierLookup`

## Impacted behavior
- `setCurrentReplicaPointer(name)` must become transactional in structure.
- Inactive-replica access should be derived on demand, not cached as permanent twin fields.
- Migration flows that use `schemaStorageForReplica(name)` continue to work, but through derived handles.

## Expected outcome
A single coherent commit point (`this._computed = ...`) after successful persistence, preventing partial runtime transitions.
