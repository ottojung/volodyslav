# IncrementalGraph synchronization specification

## Scope and state boundary

Synchronization merges compatible, validated `IncrementalGraph` snapshots while preserving exact journal identity, causal authority, freshness evidence, reset correspondence, and graph invariants. The source is read-only. A receiver publishes one atomic final state or remains unchanged.

Supported replicas share schema/computor semantics and synchronized wall clocks, and each durable `DatabaseFingerprint` identifies one writer history. Journal entries, graph records, proof edges, timestamps, references, vectors, and closed shapes are validated before use. Fingerprint collisions, rollback under one fingerprint, forged authority, clock inversion, partial persistence, and public computor reentry are outside the supported model.

The fundamental coordinate invariant is:

> A `JournalSequence` has meaning only within its `DatabaseFingerprint` author. No algorithm compares sequence magnitudes from different authors as evidence of temporal, causal, revision, presence, conflict, or destructive precedence.

An event's `(author,sequence)` is identity and same-writer order. Its immutable `causalContext` supplies cross-writer happened-before. Semantic occurrence time chooses among causal concurrency; author fingerprint breaks exact concurrent equal-time conflicts.

## Pairwise transaction

For `R <- S`:

1. enter the lifecycle/garden protocol and validate stable R and S snapshots;
2. union journal entries by exact identity, rejecting unequal payloads for one identity;
3. componentwise join `ResetAnchorCutSummary.absorbsThrough` by exact `(NodeKey,taggedAnchor)`; these summaries remain absorption metadata and do not enter `causalSummary`;
4. componentwise join `journalCoverage` and join S's durable causal summary plus every observed source event identity/context into R's `causalSummary`, without changing R's local counter;
5. compute canonical causal presence, value provenance, and freshness authority using the already-joined reset-anchor cuts;
6. reconcile identifiers and graph materializations;
7. reconstruct validity only from transportable source proofs;
8. author receiver-local semantic barriers only for genuinely new decisions;
9. canonically compact and atomically publish graph, journal, reset-anchor cut summaries, coverage, counter, causal summary, identifiers, timestamps, and proofs.

The same joined evidence produces the same semantic result in either receive direction. Physical receiver identifiers may differ, but their semantic NodeKey projection and proof relations agree. A receive commits newly observed causal knowledge even when it makes no graph change and authors no event; after that commit an ordinary local event carries the imported knowledge in its context.

## Journal-derived selection

`causallyBefore` and causal-maximal selection are defined in the journal types and synchronization documents. Every set-based semantic selector first removes events causally dominated by another eligible event. It then resolves concurrent maxima by occurrence time and author fingerprint. It never compares foreign sequence magnitudes.

### Presence

For each reset anchor, first compute causal maxima of all actual generation/delete displacements and only then classify those maxima as inside or after that anchor's cut. An after-cut displacement dominated by an inside-cut maximum supplies no live presence candidate. Scoped events retain their separate compound activation authority. Reconcile semantically eligible results by causal dominance; among concurrent causal maxima, greater occurrence time wins and exact equal time uses fingerprint. Same-author presence order follows local sequence.

Reset anchors remain fallback authority for the observed state. They are ordered as assertions by event causality; concurrent reset assertions use occurrence time then fingerprint. `absorbsThrough` decides which source events are absorbed, not which assertion observed another. A real generation/delete or activated generation above its own author's absorbed coordinate is live and can displace fallback.

Required traces:

* A:add A:500 followed by B:delete B:3 whose context covers A:500 selects delete.
* Concurrent A:add A:500 at T1 and B:add B:3 at T2 selects B when T2>T1.
* Concurrent equal-time adds select by fingerprint.
* Reset absorption through A:10 does not absorb later A:11, whatever the receiver carrier coordinate.

### Values and exact provenance

Within the selected generation, `valueHead(...,A)` is the greatest A-authored local sequence. Candidate selection removes causal domination, compares `modifiedAt` only among concurrent maxima, and uses fingerprint only for exact concurrent equal-time conflict. The selected event ID is exact provenance; it is not a globally ordered revision tuple.

Source provenance is resolved in the source's stable pre-union journal, while joined canonical provenance is resolved in the already-unioned journal. A candidate whose alleged event is absent, belongs to another key/generation, or is not canonical for its timestamp is rejected. For A:E1 at A:100 and B:E2 at B:2 with the same timestamp, if B observed E1 then E2 is canonical. If they are concurrent, fingerprint decides.

Presence selection precedes required joined provenance, coherence classification, and precedence among candidates eligible at that stage. Root values use causal/concurrent precedence among admissible candidates. Derived values first prefer coherent candidates supported by reconstructible proof; a later unsupported cache does not suppress an older coherent cache. Equal-time joined canonical provenance remains attributed to its actual canonical origin and is never borrowed from another coherent candidate.

### Extensional proof transport

A source validity edge can be transported only when:

1. the source retains that proof;
2. schema, bindings, direct-input structure, and collapsed duplicate positions match;
3. each source direct-input value is `isEqual` to the final selected input value; and
4. source output is `isEqual` to final retained output.

Equality permits transport of proof; it does not create proof. Multi-input derived nodes require every distinct input. `oldValue` is an optimization and `Unchanged` asserts semantic equality. Computors dependent on hidden time, identity, nondeterminism, or other unmodeled state must not claim transferable validity.

If coherent candidates exist, choose among candidates eligible at the coherence stage using causal/concurrent value precedence. A retained exact reset correspondence may support only the receiver anchor and exact source generation/origin pair actually compared.

### No coherent candidate

Let `unsupportedPrecedence(S)` remove causally dominated candidates from S, then choose greater `modifiedAt` among concurrent maxima, then author fingerprint for exact concurrent equal-time conflict. Same-author sequence participates only through causality. Let a candidate's **stale-retention identity** be its exact canonical value origin together with the final distinct direct-input semantic identities against which its stale cache would be reused.

After provenance and coherence classification finds no coherent candidate:

| Distinct direct inputs | Candidate state | Result |
|---|---|---|
| zero | any nonempty admissible set | retain `unsupportedPrecedence(admissible)` under the root rule |
| one | any nonempty admissible set | retain `unsupportedPrecedence(admissible)` stale |
| multiple | every present unsupported candidate has the same stale-retention identity and both sides represent that identity | retain `unsupportedPrecedence(candidates with that identity)` stale |
| multiple | present unsupported candidates have different stale-retention identities | delete |
| multiple | an unsupported candidate is opposite absence | remain absent/delete; do not copy the unsupported cache into the absent side |

Thus every permitted retention has one defined candidate selector. Multi-input retention requires agreement on the exact supported candidate identity; mere value equality, timestamp order, reset absorption, or causal observation does not manufacture that agreement. Deletion authors one causal barrier only when the joined journal does not already represent the decision.

## Freshness

Freshness is evaluated after final presence/value provenance and proof reconstruction. The all-mode and hard invalidate frontiers select greatest local sequence separately for each author. Value-specific invalidates apply only to their exact origin; explicit generation-wide invalidates apply to every origin in that generation.

One validation must cover the complete applicable frontier through its `clearsThrough`; partial validations never combine. Generic causal observation is insufficient to clear authority. Initial freshness targets the generation's exact value origin. An edit followed by stale state receives a matching later value-specific assertion.

Fresh derived state requires every direct input fresh and a complete proof. Stale-soft requires reusable proof. Hard means recomputation is required. Proof loss establishes hard authority unless an uncovered applicable hard barrier already represents it. A hard-to-soft transition first needs a positive validation clearing hard authority, followed by uncovered soft authority. Imported hard authority is sufficient and is never echoed.

## Synchronization-authored decisions

Import and semantic copying do not author journal events. A new local event is justified only by a genuinely new receiver decision, including an unsupported derived deletion or proof-loss hardening not already represented.

The event takes the next receiver-local sequence under the allocator mutex. Its `causalContext` includes every joined authority that caused the decision and carries the receiver's prior causal knowledge. If offending positive authority p caused destructive barrier b, then p is causally before b. Redelivering p cannot make it maximal against b. An unseen concurrent positive p2 can remain maximal; if it later causes a new destructive decision, that barrier observes and causally dominates p2.

Generation/initial freshness and edit/post-edit assertion pairs allocate in same-author order and publish atomically. Imported sequences never change `localJournalCounter`; only committed local authoring changes local coverage.

## Reset during synchronization

Controlled reset validates both snapshots but imports neither source journal nor source coverage. Its event context may include genuinely observed source causal history. `absorbsThrough` records source history intentionally consumed, while exact `ResetCorrespondence` records semantic `isEqual` evidence. These roles remain separate from `clearsThrough`.

For every future-relevant reset anchor consumed from either snapshot, reset reads the effective cut formed by same-anchor carriers plus the exact `ResetAnchorCutSummary`. Any authored reset lineage carries that complete cut. Summary-only absorption is therefore preserved even though source cut-summary records themselves are not installed on the receiver. Cuts from different anchors combine here only because this controlled-reset decision observed and consumed each anchor; journal projection never combines concurrent anchor cuts.

Fresh target may require one receiver validation covering the justified closed prefix. Hard target retains hard authority and no reusable incoming proof. Soft target requires cleared hard authority, reusable proof, and uncovered soft authority. Source-only authority is not silently installed as receiver-local reset authority.

Repeated reset is silent exactly when semantic graph, freshness authority, exact correspondence, absorption prefixes, and causally relevant future-union knowledge are already represented. A newly learned source prefix or context that changes future semantics is persisted even if current graph bytes are equal. Reset with unchanged source does not chase its own metadata carriers.

## Validation, deletion closure, and cutover

Input validation checks format version, exact NodeKey serialization, unique identifier mapping, graph closure, journal/reference integrity, positive arbitrary-precision event coordinates, per-author coverage, causal-context canonical shape, supported context coordinates, local counter continuity, monotone same-author carry-forward, timestamp domain, and proof envelopes.

Deletion is closed over derived dependants that cannot retain coherent proof. The transaction reasons over the full dependency cone before publication. Sequential sources are processed from fresh stable snapshots; each successful source is fully installed before the next. A failure publishes none of that source transaction. Migration and synchronization cutover obey the garden/dome/telescope/darkroom protocol.

## Polling and compaction interaction

Polling maxima are selected per `(author,NodeKey,publicAction)` by that author's local sequence. Returned events use author-major `(author,sequence)` order and cumulative vector cursors; this order makes no cross-author temporal claim. Compaction retains these maxima, causal selection antichains, exact provenance, complete freshness frontiers, validations, reset assertions/correspondences, reset-anchor cut summaries, and causal closure.

Canonical compaction satisfies `compact(compact(A) union B)=compact(A union B)`. Immutable contexts and persisted causal summary preserve the future-relevant meaning of discarded history.

## Guarantees

**Pairwise symmetry.** Given the same compatible snapshots and no receiver-only decision, both receive directions select equal presence, values, freshness class, and transferable proof.

**Absorption and idempotence.** A receive may first persist source causal knowledge as its only change. It repeats silently once that knowledge and the other joined state are represented. Reverse catch-up with no intervening authoring yields equal canonical journals, coverage, causal summaries, and semantic graphs without advancing importer counters.

**Finite destructive progress.** After user authoring stops, consider the finite set of positive authorities not yet observed by a barrier they can trigger. Each genuinely new destructive decision causally dominates at least one such observed authority and introduces only negative authority. That exact positive cannot trigger again. Each unseen concurrent positive can cause at most one later decrease when observed. Destructive authoring therefore terminates.

**Eventual consistency.** Reliable connected gossip eventually delivers the finite journal authority. ACI union, causal-maximal selection, deterministic concurrent resolution, exact proof transport, canonical compaction, and terminating destructive decisions yield equal semantic graphs by dependency-DAG induction. Roots converge by presence/value rules; derived nodes converge after their inputs and proof evidence converge. The proof applies symmetrically to every connected edge.
