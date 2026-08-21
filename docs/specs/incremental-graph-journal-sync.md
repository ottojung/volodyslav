# IncrementalGraph journal synchronization

## Journal projections

```text
presenceEvents(J,K) = generation/delete entries for K
lineageGroup(A) = all reset-lineage carriers with tagged receiver anchor A
anchorPresence(A) = absent for null; the named delete for delete anchor; the
               generation containing the named value origin for present anchor
anchorCut(A)[author] = componentwise maximum across lineageGroup(A)
superseded(A) iff A is non-null, rawPresenceHead differs from anchorPresence(A),
               and an actual presence event other than anchorPresence(A) is
               above its author coordinate in anchorCut(A)
applicableLineages = every null lineage group plus every non-null lineage group
               for which superseded(A) is false
cut[A] = max consumedThrough[A] across applicableLineages, missing as zero
postCutoffScoped(G) iff a generation-scoped event E for G exists, E is not
               itself an applicable reset-lineage carrier, and
               E.sequence > cut[E.author]
lineageActivated(G) iff postCutoffScoped(G)
eligiblePresence = actual generation/delete events above their author cut,
               plus generation G itself when lineageActivated(G)
anchorFallback = greatest actual anchorPresence among applicable non-null
               anchors; otherwise explicit absence when a null group exists;
               otherwise the greatest raw presence event
presenceHead = greatest eligiblePresence by that actual presence event's own
               JournalEntryId, or anchorFallback when eligiblePresence is empty
generation = presenceHead.id iff it is GenerationJournalEntry
valueEvents(J,K,G) = generation G union edits scoped to G
valueHead(J,K,G,A) = greatest A-authored value event
candidateEvents = defined per-author valueHeads
canonicalEvent(J,H,K,G) = greatest-ID candidate matching H.modifiedAt
ValueRevision = (modifiedAt,canonicalEvent.sequence,canonicalEvent.author)
```

Presence selection precedes value. A GenerationJournalEntry is the generation and initial value event; it is not generation-scoped. ValueRevision remains wall-time-first with exact equal-time provenance.

Freshness uses `clearsThrough`, `covers`, both frontiers, `freshnessEffective`, and `journalHard` exactly as defined in the types specification. A validation applies only to its mandatory exact `valueOrigin`; positive evidence never crosses an edit. Causal vectors never combine across validations.

Frontiers are relative to the final selected value origin: generation-wide invalidates always apply, while value-specific cache-status invalidates apply only to their named origin. A reset lineage retains an otherwise unsupported receiver cache only against the exact source generation/origin reset semantically consumed or another exact source generation/origin explicitly retained for that receiver anchor. Its causal vector is also a lineage bridge: for every event author A, consumed events at or below the A coordinate are absorbed, while later scoped events, deletes, and rematerializations activate the source lineage despite a numerically greater receiver anchor. Anchor applicability is evaluated against each anchor's own cut before raw ordering: a delayed higher-ID event inside that cut cannot disable the certificate that absorbs it; an actual post-cutoff presence event supersedes a non-null anchor. Any non-bookkeeping scoped event above its own author coordinate activates its referenced generation; the generation's older add need not itself be above the cutoff, and an applicable reset carrier/exact correspondence alone never activates it. Activation and presence ordering are separate: a scoped event can make its generation eligible, but only generation/delete IDs order presence, so an edit/validate/invalidate cannot resurrect a generation after a later delete. Missing coordinates are zero, and carrier identity is irrelevant. Present-to-absent reset anchors the vector on its real delete; absent-to-absent reset uses a no-action ResetObservationEntry anchored to that delete or to null explicit absence. A retained null observation continues suppressing delayed consumed history, but a later present lineage anchored to the current receiver generation makes that generation the fallback; the older null anchor cannot erase it. Reset lineage never authorizes an unrelated unsupported cache.

`applicableLineages(J,K)` is the single canonical selector used by presence, reset, and RLV compaction. It groups carriers by tagged receiver anchor, joins each group's vector, and includes every null group. A non-null group remains applicable while its own anchor is the raw head, allowing even a lower-ID post-cutoff event to cross it. If raw presence differs, the group remains applicable only when no actual presence event is above its own cut—so a consumed higher-ID raw event cannot disable the absorber. Once a genuinely post-cutoff presence event is also the raw head, the old non-null group is historical and excluded. A historical carrier is not current causal authority merely because polling or exact-correspondence closure retains it.

This selector governs RLV causal authority only. Exact correspondence has a different candidate-domain predicate: after causal presence selects generation G, an exact carrier is RLC-relevant when its receiver value origin is one of the retained per-author value heads of G. It remains relevant even when its present anchor does not resolve to the raw presence head, because post-cutoff activation can make G causal-current across a raw delete. Current-anchor reset bookkeeping is different again: it contains only receiver carriers whose tagged `lineage_anchor` equals the current receiver semantic anchor and that anchor's own value-origin/delete event.

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
