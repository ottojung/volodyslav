# IncrementalGraph journal synchronization

Exact definitions below apply to the [supported-state boundary](incremental-graph-journal-types.md#supported-state-boundary).

## Logical projection

```text
presenceEvents(J,K) = { E | E.key=K and (E.kind=generation or E.action=delete) }
presenceHead(J,K) = greatest JournalEntryId member, or none
generation(J,K) = presenceHead.id iff presenceHead.kind=generation; otherwise none

valueEvents(J,K,G) = { generation entry whose id=G }
                     union { scoped edit E | E.key=K and E.generation=G }
valueHead(J,K,G,A) = greatest-sequence A-authored valueEvents member
candidateEvents(J,K,G) = { valueHead(J,K,G,A) | defined }
canonicalEvent(J,H,K,G) = greatest-ID candidate whose time=H.modifiedAt(K)
origin(J,H,K,G) = canonicalEvent(J,H,K,G)
ValueRevision(J,H,K,G) = (H.modifiedAt(K),origin.sequence,origin.author)
```

Presence precedes value: losing-generation events never supply current value. ValueRevision is wall-time-first. The ID suffix chooses exact equal-time provenance. Equal revisions with unequal values are corruption.

## Freshness projection

```text
invalidateFrontier(J,K,G)[A] = greatest A-authored invalidate of either mode
hardInvalidateFrontier(J,K,G)[A] = greatest A-authored hard invalidate
covers(V,I) iff V.clearsInvalidates causally names an exact-or-later
                 same-author invalidate for I's K,G
freshnessEffective(V,J,K,G) iff V is scoped to K,G and alone covers all invalidateFrontier
journalFresh(J,K,G) iff some applicable retained V is freshnessEffective
hardnessCleared(V,J,K,G) iff V alone covers all hardInvalidateFrontier
journalHard(J,K,G) iff hardInvalidateFrontier is nonempty and no V is hardnessCleared
```

Contexts never combine. Supported generation authoring always includes one initial validate/soft-invalidate/hard-invalidate, so freshness has no implicit empty-frontier case. Graph freshness additionally requires ordinary coherence.

## Directional receive and lazy allocation

One receive is `R <- S`; S is read-only.

```text
J0 = compact(JournalR union JournalS)
C0 = componentwiseMax(CoverageR,CoverageS)
```

Validate identities, canonical addresses, variants, generation/causal references, source graph projections, and per-author coverage domination. Import alone does not raise R's local clock or local coverage coordinate. Only if reconciliation must author does the allocator lazily observe the maximum retained/covered sequence and allocate above it.

Imported generation/value/freshness events retain identity. Copying or carrying a remote generation never creates a local generation. An imported uncovered hard barrier is sufficient: enforce hard stale state silently. Author a receiver hard invalidate only for a genuinely new unrepresented must-recompute reason. No synthetic validate is authored by ordinary synchronization.

If an existing conservative rule genuinely creates receiver-local positive presence, author one GenerationJournalEntry with exact public action plus exactly one later initial freshness assertion. Import is never such a reason.

```text
J* = compact(J0 union newlyAuthoredReceiverEvents)
C* = C0
if receiver authored:
    C*[receiverFingerprint] = localJournalClock_after
```

Install atomically. For settled unchanged S, `sync(sync(R,S),S)=sync(R,S)`. With no intervening mutation, reverse receive yields identical canonical journal, coverage, and semantic graph. A receive that authors nothing does not perturb its local coordinate, so A100/B1 reverse catch-up can equalize coverage while B's local clock remains 1. Before B later authors, it observes 100 and allocates B101 or later.

## Named convergence theorems

**Directional Sync Absorption Theorem** (directional host-state domain): settled repeated `R <- S` is silent.

**Reverse Catch-Up Theorem** (journal, host-coverage, semantic-graph domains): after `R1=sync(R0,S0)`, a no-intervening-change `S1=sync(S0,R1)` which authors nothing has `Journal(S1)=Journal(R1)`, `Coverage(S1)=Coverage(R1)`, and equal semantic graphs; local allocator values need not be equal.

Directional fairness and ACI journal merge/componentwise coverage gossip give eventual convergence without a global event order.
