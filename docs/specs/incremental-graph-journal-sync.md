# IncrementalGraph journal synchronization

## Causal projections

For a finite event set S:

```text
causalMaxima(S) = { E in S | no F in S has causallyBefore(E,F) }
concurrentWinner(S) = greatest member of causalMaxima(S) by (time,author)
```

The second operation is used only after causal domination is removed. Its sequence fields are not compared. Supported synchronized clocks exclude a causally later semantic event with an earlier occurrence time.

For each NodeKey K, the reset presence projection is defined completely as follows.

```text
taggedAnchor(L) =
    ("null")                                      for explicit null absence
    ("delete", L.absentAnchor)                    for delete-anchored absence
    ("present", L.receiverValueOrigin)            for present lineage

anchorPresence(A) =
    undefined                                     when A=("null")
    the exact DeleteJournalEntry named by A       when A=("delete",id)
    the generation containing the exact origin   when A=("present",origin)

anchorCarriers(J,K,A) = reset-lineage carriers for K whose taggedAnchor is A
anchorCut(J,K,A) = componentwise maximum of every carrier.absorbsThrough
```

All named witnesses and origins must resolve to K. For a presence event E, `inside(A,E)` means `E.sequence <= anchorCut(A)[E.author]`; `after(A,E)` means the same-author comparison `E.sequence > anchorCut(A)[E.author]`. Missing coordinates are zero.

`displacements(A)` is every actual generation/delete for K distinct from `anchorPresence(A)`. Anchor A is currently applicable exactly when every causally maximal member of `displacements(A)` is inside A's cut. It is currently displaced when at least one causally maximal displacement is after A's cut. Delayed history inside the cut cannot displace the anchor. Different anchors are tested independently against their own cuts.

`applicableAnchors(J,K)` is precisely the anchors satisfying that test. Its `applicableCut[K][author]` is the componentwise maximum of their `anchorCut` values, missing as zero. An actual generation/delete E is ordinarily eligible when `E.sequence > applicableCut[K][E.author]` and E is not the concrete witness of an applicable anchor. For each generation G, a non-reset-bookkeeping scoped event E activates G when `E.generation=G.id` and `E.sequence > applicableCut[K][E.author]`; activation makes G's actual GenerationJournalEntry eligible but does not make E a synthetic presence event. Applicable reset carriers and exact correspondence metadata never activate a generation.

`fallbackAssertions(J,K)` is every individual carrier belonging to an applicable anchor. Remove O when another such carrier N satisfies `causallyBefore(O,N)`. The survivors are the fallback antichain. Occurrence time and then author fingerprint select among genuinely concurrent survivors; sequence is absent from that conflict key. The selected carrier contributes its `anchorPresence`, including explicit absence for a null anchor. `absorbsThrough` establishes only semantic absorption and never assertion happened-before.

A currently displaced anchor remains part of retained reset history even though it contributes neither cut nor fallback now: future union can make it applicable. Null, delete, and present anchors use the same applicability test; only their concrete fallback witness differs.

```text
eligiblePresence(J,K) = ordinary eligible generation/delete events
                        plus actual generations activated by scoped events
presenceMaxima(J,K) = causalMaxima(eligiblePresence(J,K))
presenceHead(J,K) = concurrentWinner(presenceMaxima(J,K)), or the selected
                    reset fallback when no eligible actual event exists
generation = presenceHead.id iff presenceHead is generation
valueEvents(J,K,G) = generation G plus edits scoped to G
valueHead(J,K,G,A) = greatest-sequence A-authored admissible value event
valueCandidates(J,K,G) = defined valueHead values over authors
canonicalAtTime(T) = concurrentWinner(causalMaxima(candidates with time=T))
```

Candidate semantic precedence is set based: remove causally dominated events, then choose the greater `modifiedAt` among concurrent maxima, then fingerprint for exact concurrent equal-time conflict. The event ID remains exact provenance, not an ordered revision tuple. Selection is staged as presence, required joined provenance/canonicalization, coherence classification, then precedence within eligible candidates. Unsupported derived caches do not suppress coherent candidates merely because their event is causally later or has a later timestamp. Equal-time joined canonical provenance retains the canonical event's actual origin.

Examples:

* A adds at A:500; B observes it and deletes at B:3 with context A:500. The add is causally before the delete, so deletion wins.
* A adds at A:500 at T1 while B concurrently adds at B:3 at T2. If T2>T1, B wins by occurrence time.
* Concurrent A and B adds at the same T resolve by fingerprint only.
* A edits at A:100 at T; B observes it and edits at B:2 at T. B's edit is canonical because A's edit causally precedes it. The foreign sequence magnitudes are irrelevant.

If reset absorbs A through 10, a later A:11 delete is live because 11 is above A's absorption coordinate. The reset carrier can have any author and local sequence. A reset followed by synchronization with the unchanged source remains at its fallback; unseen or concurrent source history above an absorbed prefix stays live.

## Freshness and coherence

Freshness uses exact origin applicability, per-author all-mode and hard frontiers, and one validation's `clearsThrough` exactly as defined by the types specification. `causalContext` cannot substitute for clearing proof. Generation-wide invalidates always apply; value-specific assertions apply only to their origin. Fresh direct inputs are required for fresh derived state. Stale inputs create a value-specific soft assertion only with coherent reusable proof; otherwise hard authority is retained or authored.

Proof transport requires existing source proof, matching schema/bindings/input structure, equal final direct-input values, and equal output. Multi-input proof requires every distinct input. Hidden nondeterminism, identity, time, or other unmodeled state is outside the extensional computor contract.

## Directional receive and convergence

For `R <- S`, S is read-only. R validates stable snapshots, computes `observedSource(S)` from S's summary plus every observed source identity/context, unions and canonically compacts journal authority, joins coverage, reconciles presence/value, transports proof, then derives freshness topologically. Atomic publication componentwise joins `observedSource(S)` into R's `causalSummary` even when no graph decision or local event occurs. This observation does not advance `localJournalCounter`; local coverage changes only through ordinary coverage union. Copying a generation/value emits no receiver generation/edit. Imported hard authority is sufficient and is not echoed.

When receive makes a genuinely new destructive decision because of positive authority p, it authors barrier b at the next receiver-local coordinate and includes p in b's `causalContext`. Thus `causallyBefore(p,b)`, and redelivery of that exact p cannot defeat b. A genuinely unseen concurrent positive p2 may remain maximal; if it later causes another destructive decision, that new barrier observes and dominates p2. The same rule governs hardening and deletion barriers.

For a finite connected execution without continuing user authoring, measure unseen positive authorities that can trigger a new destructive decision. Each decision removes at least its observed authority from that set permanently; it introduces only a negative barrier, not a positive candidate. An unseen concurrent positive can cause at most one later decrease when observed. Therefore destructive authoring terminates. ACI union, immutable contexts, deterministic causal maxima, concurrent conflict selection, exact proof transport, and canonical compaction then give equal journals and SemanticGraph on all connected replicas. The argument is symmetric for every receive direction.

The first receive may change only causal knowledge. A repeat is silent once source journal, coverage, semantic projection, and `observedSource(S)` are represented. With no intervening change, reverse catch-up produces equal canonical journals, coverage, causal summaries, and SemanticGraph while neither importer changes its local counter.
