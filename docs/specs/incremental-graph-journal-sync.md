# IncrementalGraph journal synchronization

## Journal projections

```text
presenceEvents(J,K) = generation/delete entries for K
basePresenceHead = greatest JournalEntryId presence event
lineageActivated(G) iff a retained lineage anchored at basePresenceHead
               consumed generation G and a scoped G event lies above its
               author coordinate
activatedPresenceEvents = post-cutoff generation/delete events, plus generation
               G itself when lineageActivated(G)
presenceHead = basePresenceHead when activatedPresenceEvents is empty;
               otherwise greatest activatedPresenceEvent by that presence
               event's own JournalEntryId
generation = presenceHead.id iff it is GenerationJournalEntry
valueEvents(J,K,G) = generation G union edits scoped to G
valueHead(J,K,G,A) = greatest A-authored value event
candidateEvents = defined per-author valueHeads
canonicalEvent(J,H,K,G) = greatest-ID candidate matching H.modifiedAt
ValueRevision = (modifiedAt,canonicalEvent.sequence,canonicalEvent.author)
```

Presence selection precedes value. A GenerationJournalEntry is the generation and initial value event; it is not generation-scoped. ValueRevision remains wall-time-first with exact equal-time provenance.

Freshness uses `clearsThrough`, `covers`, both frontiers, `freshnessEffective`, and `journalHard` exactly as defined in the types specification. A validation applies only to its mandatory exact `valueOrigin`; positive evidence never crosses an edit. Causal vectors never combine across validations.

Frontiers are relative to the final selected value origin: generation-wide invalidates always apply, while value-specific cache-status invalidates apply only to their named origin. A reset lineage retains an otherwise unsupported receiver cache only against the exact source generation/origin reset semantically consumed or another exact source generation/origin explicitly retained for that receiver anchor. Its causal vector is also a lineage bridge: for every event author A, consumed events at or below the A coordinate are absorbed, while later scoped events, deletes, and rematerializations activate the source lineage despite a numerically greater receiver anchor. Activation and presence ordering are separate: a scoped event can make its generation eligible, but only generation/delete IDs order presence, so an edit/validate/invalidate cannot resurrect a generation after a later delete. Missing coordinates are zero, and carrier identity is irrelevant. An absent reset target anchors the same vector on its real delete. It never authorizes an unrelated unsupported cache.

## Extensional proof transport

A validity edge is evidence that a retained output is valid for semantic input values, not permanently tied to their container/provenance IDs. A source proof may be transported/re-lowered only when:

1. the source actually contains every required valid edge;
2. schema, bindings, and direct-input structure match, with duplicate input positions collapsed exactly as graph semantics require;
3. every source direct-input value is `isEqual` to the final selected input value; and
4. the source retained output is `isEqual` to the final retained output.

Equality never mints a proof; it only permits transport of an existing proof. This is sound under the normative **extensional computor contract**: for fixed semantic bindings and input values, a proof that output d is valid remains evidence for equal input/output values independent of NodeIdentifier and journal provenance. `oldValue` is merely an optimization input; `Unchanged` asserts semantic output equality. Multi-input proofs require all distinct inputs. Computors whose validity depends on hidden nondeterminism, identity, time, or other unmodeled state must not return cache-valid/Unchanged evidence and are outside transferable-proof support.

Thus equal values at revisions R10/S100 do not harden solely because provenance differs.

## Directional receive

For `R <- S`, S is read-only:

```text
J0=compact(JR union JS)
C0=componentwiseMax(CR,CS)
```

Import alone leaves R's local clock unchanged. Reconcile presence/value deterministically, rebuild proofs by extensional transport, then derive causal freshness topologically. Fresh requires fresh direct inputs; stale inputs propagate a value-specific soft invalidate while a coherent reusable proof remains. An imported uncovered applicable hard barrier is sufficient and never echoed. Receiver-local delete/hardening is authored only for a genuinely new decision not represented by imported authority. Copying a generation/value never authors a receiver generation/edit.

Before genuine local authoring, lazily allocate above all observed retained/covered authority; then update only receiver coverage. Install atomically.

**Ordinary Convergence.** Compatible replicas with the same relevant journal evidence and no new local decision reconcile to equal SemanticGraph (presence, values, freshness class, reusable proofs).

**Directional Absorption.** Settled repeated receive is silent.

**Reverse Catch-Up.** With no intervening change and no decision authoring, `R1=sync(R0,S0); S1=sync(S0,R1)` yields identical canonical journals, coverage, and SemanticGraph; S's local clock need not rise on import.
