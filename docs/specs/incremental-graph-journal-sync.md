# IncrementalGraph journal synchronization

An ordinary receive is directional: `R <- S`; S is a stable read-only snapshot and only R commits.

```text
J0 = compact(JournalR union JournalS)
C0 = componentwiseMax(CoverageR, CoverageS)
```

Before interpretation, validate immutable-ID agreement, self-contained address identity, variants, generation/context references, and coverage domination. Raise R's local allocator by the observation rule before local authoring. Reconcile the two graph snapshots using merged logical evidence, without running computors.

Reconciliation authors a receiver event only for a genuine receiver-local decision: delete for newly destructive presence, soft invalidate for real propagated fresh-to-stale with sufficient proofs, or hard invalidate when it newly establishes must-recompute state. It authors no synthetic validate and no add/edit for copying remote value or provenance.

```text
J* = compact(J0 union newlyAuthoredReceiverEvents)
C* = C0
C*[receiverFingerprint] = localJournalClockR_after
```

Graph, journal, coverage, allocator, and related metadata install atomically. Importing an event is sufficient polling evidence under its original author coordinate. A consumer that already accounted for it intentionally skips it on any receiver.

For unchanged S and settled state, `sync(sync(R,S),S)=sync(R,S)`. If `R1=sync(R0,S0)` and no relevant mutation intervenes, then `S1=sync(S0,R1)` has the identical compact journal, coverage, and semantic graph as R1. A receiver hardening/destructive event authored during the first receive is imported unchanged by the reverse receive; the represented decision cannot cause a symmetric duplicate.

If R mutates before reverse receive, S simply imports the newer R events and reconciles normally. This is convergence/absorption across two directional transactions, never an atomic bidirectional operation. Under directional fairness, stable reachable replicas eventually gossip every retained event or equivalent compact evidence plus componentwise coverage, and deterministic reconciliation converges.

Three-host arrival order is irrelevant: union and canonical compaction erase transport order. Offline authors retain independent coordinates; allocator gaps are closed by coverage. Compaction before versus after receive agrees by future-union closure.
