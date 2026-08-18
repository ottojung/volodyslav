# IncrementalGraph journal migration

Migration atomically transforms schema, graph, the single journal, coverage, allocator, fingerprint, and related metadata. It validates addresses, variants, generations, all-mode causal contexts, and the supported-state boundary before installation.

A real propagated fresh-to-stale transition with sufficient proofs emits soft invalidate. Removing proofs or newly establishing must-recompute emits hard invalidate only when no applicable uncovered hard barrier already represents that obligation. Enforcing or carrying an existing barrier is silent. Settled hard state never reauthors endlessly. Stale-to-fresh migration authors validate only if that lifecycle explicitly performs authoritative revalidation; its `clearsInvalidates` captures the complete observed all-mode frontier. Otherwise migration does not synthesize validate.

Coverage never regresses; the local coordinate equals the durable clock and dominates retained local entries. Allocator advances may close gaps. Schema or structural failure aborts atomically.

Absent-state self-restoration instead restores this same host's exact graph, journal, coverage, clock, fingerprint, and related state. Rollback under one writer fingerprint remains unsupported without an anti-rollback/new-writer protocol.
