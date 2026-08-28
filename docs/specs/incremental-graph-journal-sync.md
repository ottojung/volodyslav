# IncrementalGraph journal synchronization

## Journal projections

```text
presenceEvents(J,K) = generation/delete entries for K
rawPresenceHead(J,K) = greatest member of presenceEvents(J,K) by
               JournalEntryId=(sequence,author), or undefined when that set is empty
lineageGroup(A) = all reset-lineage carriers with tagged receiver anchor A
anchorPresence(A) = absent for null; the named delete for delete anchor; the
               generation containing the named value origin for present anchor
anchorCut(A)[author] = componentwise maximum across lineageGroup(A)
superseded(A) iff A is non-null, rawPresenceHead(J,K) is defined and differs
               from anchorPresence(A), and rawPresenceHead(J,K).sequence is above
               anchorCut(A)[rawPresenceHead(J,K).author]
applicableLineages = every null lineage group plus every non-null lineage group
               for which superseded(A) is false
cut[A] = max consumedThrough[A] across applicableLineages, missing as zero
postCutoffScoped(G) iff a generation-scoped event E for G exists, E is not
               itself an applicable reset-lineage carrier, and
               E.sequence > cut[E.author]
lineageActivated(G) iff postCutoffScoped(G)
applicableAnchorPresences = every defined anchorPresence of an applicable
               reset-lineage group
eligiblePresence = actual generation/delete events above their author cut that
               are not members of applicableAnchorPresences,
               plus generation G itself when lineageActivated(G)
fallbackAssertions = individual carriers in applicable lineage groups
assertion N dominates O iff either they have the same author and receiverAnchor
               and N.sequence > O.sequence, or N's own consumedThrough covers
               O's anchorPresence coordinate when non-null and O's carrier coordinate
anchorFallback = anchorPresence of a maximal fallback assertion, using a
               canonical full-carrier-ID/tagged-anchor conflict tie-break only
               for incomparable maxima; otherwise explicit absence when a null assertion wins;
               otherwise the greatest raw presence event
presenceHead = greatest eligiblePresence by that actual presence event's own
               JournalEntryId, or anchorFallback when eligiblePresence is empty
generation = presenceHead.id iff it is GenerationJournalEntry
valueEvents(J,K,G) = generation G union edits scoped to G
valueHead(J,K,G,A) = greatest A-authored value event
candidateEvents(J,K,G) = the set of defined valueHead(J,K,G,A), over all authors A
canonicalEvent(J,K,G,T) = greatest-ID candidate in candidateEvents(J,K,G)
               whose event time equals T
ValueRevision(J,H,K,G) = (H.modifiedAt,canonicalEvent(J,K,G,H.modifiedAt).sequence,
               canonicalEvent(J,K,G,H.modifiedAt).author)
applicable(I,O) iff I is generation-wide or I.valueOrigin=O
invalidateFrontier(J,K,G,O)[A] = greatest A-authored applicable invalidate
               of either mode for K and G
hardInvalidateFrontier(J,K,G,O)[A] = greatest A-authored applicable hard
               invalidate for K and G
covers(V,I) iff V and I have the same key and generation and
               I.sequence <= V.clearsThrough[I.author]
freshnessEffective(V,J,K,G,O) iff V.valueOrigin=O and V alone covers every
               member of invalidateFrontier(J,K,G,O)
hardnessCleared(V,J,K,G,O) iff V.valueOrigin=O and V alone covers every
               member of hardInvalidateFrontier(J,K,G,O)
journalHard(J,K,G,O) iff hardInvalidateFrontier(J,K,G,O) is nonempty and
               no validation V satisfies hardnessCleared(V,J,K,G,O)
```

Presence selection precedes value. A GenerationJournalEntry is the generation and initial value event; it is not generation-scoped. `H` is one graph materialization from the graph snapshot paired with journal snapshot `J`; `canonicalEvent` and `ValueRevision` are evaluated only in that same snapshot, before any journal union. `canonicalEvent` is undefined when no candidate has `time=T`. ValueRevision remains wall-time-first with the journal event's exact `(sequence,author)` equal-time suffix.

An applicable reset anchor's presence event participates only through `anchorFallback`; its locally authored sequence does not independently make it an ordinary post-cutoff candidate. A genuinely post-cutoff scoped event can nevertheless activate that anchor generation through `lineageActivated(G)`, after which the generation participates in ordinary presence ordering.

Concrete lower-sequence live-delete trace: source A's generation is at A:9 with its initial freshness event at A:10, and reset consumes A through sequence 10. The receiver has unrelated observed clock 100, so it authors its retained anchor generation at receiver sequence 101 (and its initial freshness assertion after that). Source A subsequently authors delete A:11. The receiver anchor is excluded from ordinary candidates and remains only the fallback; A:11 is above A's cutoff, remains live, and wins even though `11 < 101`. The result is absent.

Freshness uses `clearsThrough`, `covers`, both frontiers, `freshnessEffective`, and `journalHard` exactly as defined in the types specification. A validation applies only to its mandatory exact `valueOrigin`; positive evidence never crosses an edit. Causal vectors never combine across validations.

Frontiers are relative to the final selected value origin: generation-wide invalidates always apply, while value-specific cache-status invalidates apply only to their named origin. A reset lineage retains an otherwise unsupported receiver cache only against the exact source generation/origin reset semantically consumed or another exact source generation/origin explicitly retained for that receiver anchor. Its causal vector is also a lineage bridge: for every event author A, consumed events at or below the A coordinate are absorbed, while later scoped events, deletes, and rematerializations activate the source lineage despite a numerically greater receiver anchor. Anchor applicability is evaluated against each anchor's own cut before raw ordering: a delayed higher-ID event inside that cut cannot disable the certificate that absorbs it; a non-null anchor is superseded only when the raw displacement itself is post-cutoff. An unrelated lower-ID live presence event remains eligible without releasing a consumed raw event. Any non-bookkeeping scoped event above its own author coordinate activates its referenced generation; the generation's older add need not itself be above the cutoff, and an applicable reset carrier/exact correspondence alone never activates it. Activation and presence ordering are separate: a scoped event can make its generation eligible, but only generation/delete IDs order presence, so an edit/validate/invalidate cannot resurrect a generation after a later delete. Missing coordinates are zero, and carrier identity is irrelevant. Present-to-absent reset anchors the vector on its real delete; absent-to-absent reset uses a no-action ResetObservationEntry anchored to that delete or to null explicit absence. A retained null observation continues suppressing delayed consumed history, but a later present lineage anchored to the current receiver generation makes that generation the fallback; the older null anchor cannot erase it. Reset lineage never authorizes an unrelated unsupported cache.

`lineageGroups(J,K)` groups all retained carriers by tagged receiver anchor and joins vectors only within each group. `applicableLineages(J,K)` is its current-presence subset: every null group plus each non-null group whose anchor is raw-current or whose raw displacement lies inside that group's cut. Once the raw displacement itself is genuinely post-cutoff, the group is currently inapplicable—but it is not necessarily disposable, because a future union can replace that displacement with consumed history and make the group applicable again.

Fallback causality is assertion-specific, never inferred from a joined group's first carrier. Same-author assertions on the same semantic anchor form a writer-local succession chain: larger sequence replaces smaller sequence, and supported authoring requires the later assertion's vector to componentwise dominate the earlier vector. This bounded replacement does not insert the omitted carrier coordinate into `consumedThrough`; the immutable same-writer order supplies succession while omission prevents an unchanged reset from chasing its own clock. For different authors or different anchors, assertion N dominates O only when N's **own** `consumedThrough` covers O's actual anchor-presence coordinate (when non-null) and O's immutable carrier coordinate. A vector contributed concurrently by another assertion in N's anchor group cannot manufacture that cross-anchor observation. Therefore `A1 -> B1 -> A2` selects A2 when A2 observed B1 even though B1 observed historical A1 in A's joined group; later B2 selects B2 only after observing A2. Concurrent incomparable assertions use canonical full carrier ID and tagged-anchor order solely as a deterministic conflict rule.

RLV compaction takes the maximal assertion antichain across every retained lineage group, including currently inapplicable groups, and retains each represented anchor's per-author coordinate witnesses. This is the future-relevant retention predicate. A dominated assertion is safely subsumed by the assertion that observed it; an undominated inapplicable assertion remains because it can regain applicability under future union.

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
