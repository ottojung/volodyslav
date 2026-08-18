# IncrementalGraph journal synchronization

This document defines the exact journal-derived functions used by graph synchronization. They apply only to the [supported-state boundary](incremental-graph-journal-types.md#supported-state-boundary).

## Logical projection

For journal J and key K:

```text
presenceEvents(J,K) = { E in J | E.key=K and E.action in {add,delete} }
presenceHead(J,K) = max by JournalEntryId of presenceEvents(J,K), or none
generation(J,K) = presenceHead(J,K).id iff presenceHead.action=add; otherwise none

valueEvents(J,K,G) =
    { add G } union { E in J | E.key=K, E.action=edit, E.generation=G }
valueHead(J,K,G,A) = greatest-sequence A-authored member of valueEvents(J,K,G)
candidateEvents(J,K,G) = { valueHead(J,K,G,A) | defined for A }
```

Presence is selected before value. Events scoped to a losing generation cannot supply the current value regardless of sequence or time.

For graph snapshot H with `modifiedAtUnix(H,K)`:

```text
canonicalEvent(J,H,K,G) =
    greatest JournalEntryId among E in candidateEvents(J,K,G)
    where E.time = modifiedAtUnix(H,K)

origin(J,H,K,G) = canonicalEvent(J,H,K,G)
ValueRevision(J,H,K,G) =
    (modifiedAtUnix(H,K), origin.sequence, origin.author)
```

A candidate is admissible only when its exact origin exists, belongs to G, is its author's value head, matches graph `modifiedAt`, and is the canonical event among equal-time candidates. `ValueRevision` compares lexicographically, wall time first, then sequence, then author. Equal revisions with unequal values are corrupt. This preserves exact finite-resolution provenance without treating Lamport sequence as a global value clock.

## Freshness projection

```text
invalidates(J,K,G,A) =
    { I in J | I.action=invalidate, I.author=A, I.key=K, I.generation=G }
invalidateFrontier(J,K,G)[A] = greatest-sequence member of invalidates(...)

hardInvalidates(J,K,G,A) = { I in invalidates(...) | I.mode=hard }
hardInvalidateFrontier(J,K,G)[A] = greatest-sequence member of hardInvalidates(...)

covers(V,I) iff
    V.action=validate and V.key=I.key and V.generation=I.generation and
    V.clearsInvalidates[I.author] resolves to invalidate C and
    C.author=I.author and C.key=I.key and C.generation=I.generation and
    C.sequence >= I.sequence

freshnessEffective(V,J,K,G) iff
    V individually covers every I in invalidateFrontier(J,K,G)

hardnessCleared(V,J,K,G) iff
    V individually covers every I in hardInvalidateFrontier(J,K,G)
```

No union of partial validation contexts is permitted. `journalFresh(J,K,G)` holds only if some retained applicable validation is freshness-effective; the graph may be fresh only when that and ordinary exact graph coherence both hold. `journalHard(J,K,G)` holds when the hard frontier is nonempty and no single applicable validation is hardness-clearing. An empty hard frontier is non-hard without requiring a validation. Consequently an older V followed by a later soft S yields stale-soft, while V covering hard H but preceding soft S also yields stale-soft.

## Directional receive

One receive is `R <- S`; S remains read-only.

```text
J0 = compact(JournalR union JournalS)
C0 = componentwiseMax(CoverageR,CoverageS)
```

Validate immutable identities, address identity, variants, structural references, source graph projection, coverage domination, and supported-state invariants. Raise R's allocator by the observation rule before any receiver authoring. Reconcile fixed graph snapshots using the definitions above without running computors.

An imported uncovered hard barrier is already exact causal and polling authority. R enforces hard stale state and removes/declines proofs **without** authoring an echo. R authors a new hard invalidate only when reconciliation newly establishes must-recompute for a reason not represented by an applicable uncovered hard barrier in J0. It may author delete for a genuinely new destructive decision or soft invalidate for a genuine propagated stale transition not already represented. It never authors synthetic validate or add/edit for copying remote state.

```text
J* = compact(J0 union newlyAuthoredReceiverEvents)
C* = C0
C*[receiverFingerprint] = localJournalClockR_after
```

Install graph, journal, coverage, allocator, and related metadata atomically.

For unchanged S and settled state, `sync(sync(R,S),S)=sync(R,S)`. If `R1=sync(R0,S0)` and no relevant mutation intervenes, `S1=sync(S0,R1)` has identical canonical journal, coverage, and semantic graph. Receiver events genuinely created in the first receive are imported unchanged and not duplicated in reverse. If R mutates between receives, reverse receive imports those newer events normally. These are two directional transactions, not one bilateral transaction.

Directional fairness plus journal merge algebra and componentwise coverage gossip yields eventual convergence. Arrival order, offline authors, and allocator gaps do not create a global order.
