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
taggedAnchor(E) =
    ("null")                         for ResetObservationEntry with absentAnchor=null
    ("delete",E.absentAnchor)        for ResetObservationEntry with absentAnchor!=null
    ("delete",E.id)                  for DeleteJournalEntry carrying resetLineage
    ("present",E.valueOrigin)        for ValidateJournalEntry carrying resetLineage
    ("present",E.appliesTo.valueOrigin)
                                     for value-specific InvalidateJournalEntry carrying resetLineage

anchorPresence(A) =
    undefined                                     when A=("null")
    the exact DeleteJournalEntry named by A       when A=("delete",id)
    the generation containing the exact origin   when A=("present",origin)

anchorCarriers(J,K,A) = reset-lineage carriers for K whose taggedAnchor is A
anchorCut(J,K,A) = componentwise maximum of every carrier.absorbsThrough and
                   the compact ResetAnchorCutSummary for exactly (K,A), if present
```

All named witnesses and origins must resolve to K. A generation-wide invalidate cannot carry reset lineage. For a presence or scoped event E, `inside(A,E)` means `E.sequence <= anchorCut(A)[E.author]`; `after(A,E)` means the same-author comparison `E.sequence > anchorCut(A)[E.author]`. Missing coordinates are zero.

`displacements(A)` is every actual generation/delete for K distinct from `anchorPresence(A)`, and `maximalDisplacements(A)=causalMaxima(displacements(A))`. Causal domination is computed before any member is classified against the cut. Anchor A is currently applicable exactly when every member of `maximalDisplacements(A)` is inside A's cut. It is currently displaced when at least one member is after A's cut. A causally dominated after-cut event is not independently live when its dominating maximal displacement is inside the cut. Delayed history inside the cut cannot displace the anchor. Different anchors are tested independently against their own cuts.

`applicableAnchors(J,K)` is precisely the anchors satisfying that test. There is no joined cut across different anchors. For each applicable anchor A independently:

1. its ordinary live presence events are the members E of `maximalDisplacements(A)` with `after(A,E)`; cut classification never resurrects a causally dominated displacement;
2. a non-reset-bookkeeping scoped event E with `after(A,E)` activates its exact generation G; activation admits G's actual GenerationJournalEntry but E is not a synthetic presence event;
3. reset carriers and exact correspondence metadata never activate a generation;
4. causal maxima followed by occurrence time and fingerprint choose A's live presence result when the set is nonempty;
5. otherwise A's result is `anchorPresence(A)`, including absence for the null anchor.

`fallbackAssertions(J,K)` is every individual carrier belonging to an applicable anchor. Remove O only when another carrier N satisfies `causallyBefore(O,N)`. Each survivor supplies the result derived with its own anchor's cut. A live actual presence result has compound authority `(presenceEvent, presenceEvent)`. An activated generation has compound authority `(presence=G, conflictAuthority=E)`, where G is the actual GenerationJournalEntry and E is the scoped event that activated it; E never becomes a presence event. An anchor fallback has `(presence=anchorPresence, conflictAuthority=carrier)`. Reconcile results by removing causally dominated `conflictAuthority` events, then use conflict-authority occurrence time and author fingerprint for genuine concurrency. Thus a real delete D is compared with E, not with G, when competing against an activated generation. Sequence is absent from that conflict key. `absorbsThrough` establishes only semantic absorption for its one tagged anchor and never assertion happened-before.

If there is no reset assertion, apply the ordinary causal-maximal presence rule to all actual presence events. A currently displaced anchor remains retained but contributes no result until applicable. Null, delete, and present anchors use the same applicability test; only their concrete fallback witness differs.

```text
anchorResult(J,K,A) = result derived relative only to anchorCut(A)
presenceHead(J,K) = causal/concurrent reconciliation of results supplied by
                    causal-maximal applicable fallback assertions;
                    ordinary causal presence when there is no assertion
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

## Iterator restoration interaction

Journal synchronization unions immutable events and increases
`journalCoverage`; it does not mutate any application-owned `JournalIterator`.
A transferred durable iterator state is restorable only when receiver coverage
componentwise dominates its recorded issuance coverage. A receive may establish
that condition. Receipt of events is possession, not consumption, so existing
iterator progress remains unchanged.
