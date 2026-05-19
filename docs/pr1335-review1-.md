# PR #1335 Review 1 — Problem Analysis

## Feedback theme
The feedback identifies a state-management design flaw in `root_database.js`: active replica state is spread across multiple mutable fields, so replica switching is not modeled as one coherent transactional state transition.

## Precise problem
Current design keeps duplicate mutable runtime state:
- active replica name cache
- per-replica cached namespace/global sublevels
- per-replica cached schema storages
- separately cached identifier lookup

This fragmentation creates risk of divergence (e.g., pointer changed but some dependent fields stale).

## Required architectural correction
Use a single active-state object (`this._computed`) as the one mutable reference for all active replica-derived runtime handles:
- replicaName
- namespaceSublevel
- globalSublevel
- schemaStorage
- identifierLookup

Replica switch must be atomic in structure:
1. validate name
2. derive candidate sublevels from db
3. build candidate schema storage
4. load candidate identifier lookup
5. persist pointer
6. commit by replacing `this._computed` once

## Storage model distinction
- Physical DB still uses two replica namespaces (`x`, `y`).
- Runtime object should cache only the active bundle.
- Inactive replica handles should be derived on demand from helper methods, not kept as permanent parallel cached fields.
