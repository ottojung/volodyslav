# IncrementalGraph journal migration

Migration transforms schema, graph, the single journal, coverage, allocator, fingerprint, and related metadata in one atomic transaction. It validates self-contained addresses and all structural references before installation.

A migration authors precise local events only for real semantic decisions. Propagated/freshness-only staleness with sufficient proofs emits soft invalidate. Removing proofs or otherwise establishing must-recompute state emits hard invalidate, including stale-to-stale hardening. Settled state already carrying an outstanding hard barrier is silent. Migration does not synthesize validation.

Coverage never regresses; after commit its local coordinate equals the durable local clock and dominates every retained entry. Allocator advances can create closed gaps. Schema failures or malformed persisted journal state fail the migration atomically.

Absent-state self-restoration is not migration: it restores the exact same host's graph, journal, coverage, local clock, fingerprint, and all related durable state. Rollback under the same writer fingerprint remains unsupported without an explicit anti-rollback/new-writer protocol.
