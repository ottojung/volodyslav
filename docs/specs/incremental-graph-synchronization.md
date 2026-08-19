# IncrementalGraph synchronization specification

## Scope and state boundary

This specification inherits supported and corrupted/unsupported state from
[`database-lifecycle.md`](database-lifecycle.md#11-corruption-model) through the
[journal supported-state boundary](incremental-graph-journal-types.md#supported-state-boundary).
Its correctness and convergence claims quantify only over supported reachable
snapshots and history deliveries/unions that can arise between them, not
arbitrary structurally constructible journal sets. Defensive validation MAY
reject additional corruption, but complete detection, recovery, and
preservation of forensic evidence are not promised.

Synchronization is decentralized bilateral reconciliation of two complete,
reachable snapshots:

```text
A = (GraphA, JournalA)
B = (GraphB, JournalB)
```

There is no leader, convergence host, all-to-all requirement, or computor
execution. Normal `pull()` and `invalidate()` remain flag-based. The journal is
history used to interpret candidates; the graph remains authoritative for
current values, materialization, freshness, timestamps, and validity.

Graph materializations contain only values, freshness, real wall-clock
`timestamps {createdAt,modifiedAt}`, `NodeIdentifier`/identifier lookup, and
`valid`. They contain no revision stamp, event ID, support vector, epoch,
counter, logical timestamp, vector clock, or CRDT field. Synchronization never
changes `modifiedAt` merely because it selects or copies a value.

Both inputs are retained as pre-merge graph+journal views for provenance checks.
The journals are joined first. Nodes are then processed in schema DAG
topological order, and the reconciled graph and joined/locally extended journal
commit atomically. Invalid graph/journal combinations outside reachable
transitions are corruption, not conflicts for which this protocol invents data.

## Guarantees and deliberate limits

Synchronization provides stable retained-journal identity for represented value
versions, deterministic timestamp-collision resolution, presence generations,
generation-scoped freshness barriers, and coherence decisions from the evidence
available in its two reachable source snapshots and retained journal history.
Insufficient evidence is handled conservatively. Synchronization invokes no
computor and invents no `ComputedValue`; journal merge is ACI; bilateral gossip
is decentralized; journal notifications have no action-specific false
negatives; and fully compacted journal plus coverage storage is `O(nr²+r)`, reducing to `O(nr²)` for `n>0,r>=1`, under the journal size model's explicit fixed maximum serialized semantic-address size;
`DatabaseFingerprint` is already bounded by its normative 16-character ASCII
representation, and uncompacted storage may grow with operations. The broader storage model also assumes fixed maximum
serialized `ConstValue` size C and fixed direct graph
in-degree d for value-address and persisted dependency/validity state,
respectively; these are separate premises, and d is not needed to count `J`.

The journal does not provide complete historical input-version provenance for
cached derived values. For D with direct inputs I1...Ik, synchronization is not
guaranteed to reconstruct the exact historical vector
`[version(I1),...,version(Ik)]` against which every retained value of D was
computed. Consequently, a cache may be retained stale or deleted when the
represented evidence cannot establish coherence. For a multi-input node this
may delete a value even though richer historical provenance could have proved
some `oldValue` safe. Maximal old-value preservation is not guaranteed.

Additional historical provenance could permit stronger preservation, but that
behavior is outside this specification. These limits are exhaustive for
historical reconstruction and `oldValue` preservation; no componentwise history
reconstruction or stronger maximal-preservation property is implied.

## Journal-derived frontiers

### Clock assumptions

All participating hosts in a supported execution are assumed to share a
synchronized real wall clock. For value-changing events E1 and E2, if E1 occurs
before E2 in real time, then `E1.time <= E2.time`. Wall-clock timestamps are
therefore the intended real-time order and the primary
cross-host coordinate within `ValueRevision` ordering among candidates still
eligible at the relevant selection stage. This does not make wall time a global
override of presence-generation applicability, collision canonicalization,
coherence classification, or fallback rules.

Wall-clock timestamps have finite resolution and are not injective: distinct
value-changing operations may receive exactly equal timestamps. The journal
identity deterministically disambiguates those collisions. Cross-host clock
skew, clock rollback, or any condition that can invert real event order in
wall-clock timestamps is outside the supported execution model. "Undefined"
means that synchronization correctness and value-selection guarantees do not
apply; implementations need not detect the condition. Volodyslav does not
detect, repair, compensate for, or preserve causality across unsynchronized
wall clocks.

This specification uses the exact definitions in the [journal synchronization specification](incremental-graph-journal-sync.md#logical-projection), including `presenceHead`, `generation`, `valueEvents`, `valueHead`, `candidateEvents`, `canonicalEvent`, `origin`, `ValueRevision`, `covers`, both invalidation frontiers, `freshnessEffective`, and `hardnessCleared`. In shorthand:

```text
modifiedAtUnix(x) = toUnixTimestamp(graph.timestamps[x].modifiedAt)
ValueRevision(x,G) = [modifiedAtUnix(x), origin(x,G).sequence, origin(x,G).author]
invalidateFrontier(x,G)[A] = greatest invalidate of either mode by A
hardInvalidateFrontier(x,G)[A] = greatest hard invalidate by A
freshnessEffective(V,x,G) iff V alone covers every all-mode frontier member
hardnessCleared(V,x,G) iff V alone covers every hard-frontier member
```

A value event for winning generation G is usable only when it is the GenerationJournalEntry G or an edit explicitly scoped to G, its `time` equals `modifiedAtUnix(x)`, and it is
`valueHead(author,x,G)`. An unresolvable, superseded, or differently scoped
materialization is provenance-obsolete. `ValueRevision(x,G)` is compared
lexicographically and totally. Equal revisions with unequal `ComputedValue`s
violate the reachable-state invariant; synchronization rejects corruption and
does not add a hash tie-break.

These are distinct orders:

```text
ValueRevision ordering:
    modifiedAtUnix first, as synchronized cross-host real-time order
    sequence second
    author database fingerprint third

canonical provenance among events with equal modifiedAtUnix:
    JournalEntryId = (sequence,author)
```

Thus `modifiedAtVirtual` and `modifiedBy` provide exact deterministic identity
when finite-resolution wall times collide. `modifiedAtVirtual` does not replace
wall time and is not intended to repair an unsynchronized system clock.
For `T1 < T2`, T2 wins by wall time regardless of journal sequences. For equal
T, greater sequence wins. For equal timestamp and equal sequence, greater author
database fingerprint wins because distinct concurrent authors may allocate the same
numeric sequence. This suffix exactly matches sequence-first
`JournalEntryId=(sequence,author)`. No hash or value-equality fallback is used as
revision identity. Thus `[201,1,B] > [200,1000,A]`: sequence never becomes the
primary global value clock.

For an exact `modifiedAtUnix` collision inside G, the greatest matching event by
`JournalEntryId=(sequence,author)` is canonical. A source candidate resolves its
alleged event from its own pre-merge reachable snapshot and is admissible after
journal join only if that event is `canonicalEvent(x,G)`. Selection MUST NOT keep another
tied candidate and attribute the canonical event to it. If the canonical
candidate is unsupported, lower tied coherent candidates are excluded and the
conservative no-coherent rule applies.

A delete presence head prevents lower-ordered generations from resurrecting.
A greater add may rematerialize under LWW order whether causally later or
concurrent with unrelated high Lamport history. If
the joined head says present but no source carries usable bytes for that
presence generation, the result is absent; a genuinely new decision emits a
delete barrier.

For final winning generation G, `invalidateFrontier` contains every author's greatest invalidate of either mode, while `hardInvalidateFrontier` contains every author's greatest hard invalidate. A validation permits journal freshness only when it individually covers the complete all-mode frontier. It clears must-recompute authority when it individually covers the hard frontier. Numeric order is not observation and contexts from separate validations MUST NOT be combined. Freshness additionally requires ordinary exact graph coherence. Other-generation contexts have no authority; an empty hard frontier is non-hard without any validation.

## Transient semantic support

For derived D and source snapshot S, collapse duplicate direct input positions according to graph semantics. `SupportS(D)` is known only when S actually has every required `valid[I].has(D)` edge. It is transportable only when schema/bindings/direct-input structure match, every source input value is `isEqual` to the final input value, and S's retained D output is `isEqual` to the final retained output. Equality alone never creates support.

This relies on the extensional computor contract in the journal-sync specification. Exact input ValueRevision equality is not required: equal values at different provenance revisions may carry an existing proof. `oldValue`, Unchanged, multi-input, duplicate-input, and hidden-nondeterminism boundaries follow that contract.

## Symmetric pairwise graph merge

The following rules depend only on the two source snapshots and canonical total
orders. Therefore the semantic graph decision is independent of argument order;
local paths, inactive slots, cursor positions, and the author chosen to record a
new destructive fact are physical commit details.

### 1. Presence

Apply joined presence history first. Discard any materialization whose add
generation predates the newest applicable delete. If final presence is absent,
delete the node and maintain dependency-closure deletion. Do not spread a
materialization when no usable source carries the current generation.

If the joined `presenceHead(N)` is generation G, derive each candidate's source
generation from its source pre-merge `presenceHead(N)` and admit it only when
that generation equals G. This applies to concurrent adds as well as adds around
deletes. Value ordering and coherence selection occur only inside G; they cannot
select bytes from a losing presence generation.

Only GenerationJournalEntry G and edits explicitly scoped to G participate in G's value heads.
Losing-generation edits are discarded before wall-time, author, sequence, or
coherence comparison, even when one is the retained edit notification maximum.

### 2. Candidate resolution

Every candidate enters this phase with `ValueRevision(N,G)` already resolved in
its own validated pre-merge source. Apply the joined heads and discard candidates
made obsolete only by valid joined history. An internally unresolvable source
cannot reach this phase. A source container is never part of semantic identity.

When G-scoped source events share `modifiedAt`, determine `canonicalEvent(N,G)`
before coherence selection and discard candidates alleged to originate at a
lower tied event. This ordering is necessary because provenance is not persisted
on materializations.

For a zero-input node choose the candidate with greatest
`ValueRevision(N,G)`. This is the complete root rule.

### 3. Derived coherence

Direct inputs have already reached their final selections. Classify each
candidate as coherent or unsupported using its own existing source proof plus structural and `isEqual` semantic input/output checks against final values. If coherent candidates exist, choose the coherent
candidate with greatest `ValueRevision`. A newer-timestamp unsupported candidate
never suppresses a coherent one.

Thus “`modifiedAt` is primary” means primary inside `ValueRevision` comparison
among candidates eligible at that selection stage. Roots order admissible
candidates directly by `ValueRevision`. Derived nodes resolve presence and
equal-time canonical events, classify coherence, and only then order the
coherent candidates by `ValueRevision`; a newer unsupported derived cache is not
guaranteed to defeat an older coherent cache.

### 4. No coherent candidate

* Zero distinct inputs use the root greatest-revision rule.
* One distinct input retains the greatest admissible candidate but makes it
  potentially outdated, preserving useful `oldValue` behavior.
* More than one distinct input is conservative:
  * the exact same revision on both sides may be retained stale;
  * different unsupported revisions are deleted;
  * one unsupported revision opposite absence is not spread into the hole and
    the result is absent/deleted.

These fallbacks express inability to establish coherence from retained evidence,
not proof that the cached value lacked some historically coherent computation.
In particular, deletion is not specified as an if-and-only-if test over
incomparable historical input vectors.

A newly derived deletion authors one `delete` entry after every entry observed
by the operation. If a covering barrier already justifies the result, propagate
it without authoring another.

### 5. Validity reconstruction

Never union `valid`. Rebuild incoming validity edges only by transporting an existing source proof whose structure and semantic input/output values match the final graph under `isEqual`. Structural dependency edges come from the schema.

Determine hard state first. If `hardInvalidateFrontier(N,G)` is nonempty and no single validation is `hardnessCleared`, N is hard-stale and receives no incoming proofs. If the hard frontier is empty or individually cleared but no validation is `freshnessEffective` because a later soft invalidate remains uncovered, N is stale-soft: coherent reusable proofs may remain or be transported, and cache-only revalidation remains possible. A freshness-effective validation can permit fresh state only with ordinary exact graph coherence.

Operationally, a derived stale-soft materialization MUST retain the complete reusable incoming proof required for cache-only revalidation. If reconciliation cannot retain or transport that proof, the result is must-recompute and requires an uncovered hard barrier. A zero-input stale materialization has no incoming proof to reuse and therefore cannot be stale-soft in the supported model; its negative freshness assertion is hard.

### 6. Freshness and synchronization authoring

The all-mode frontier prevents an old validation from crossing a delayed soft invalidate. The hard subset separately determines must-recompute authority. Partial validations never combine.

An imported applicable uncovered hard barrier is sufficient authority. Synchronization enforces it and removes or declines proofs silently; it MUST NOT author a receiver echo. A new receiver hard invalidate is authored only when this transaction establishes must-recompute for a reason not represented by any applicable uncovered hard barrier in the merged journal—for example, stale-soft proof removal caused by a newly discovered incoherent final input when the hard frontier is empty or cleared. Settled represented hard state is silent. Synchronization never synthesizes validate except the mandatory initial freshness assertion paired atomically with a genuinely receiver-authored new generation; importing/copying a generation is not such authoring.

One receive has an explicit transaction occurrence time `τreceive`. Every receiver-local hard invalidate or deletion-closure delete uses `time=τreceive`; it does not change the retained value's `modifiedAt`. Imported invalidate/delete entries preserve their immutable original time and are never re-authored merely to acquire the receiver time. Journal sequence allocation remains independent of wall time.

Imported-barrier trace: S has hard I_S and no proofs; R has the same generation/value and reusable proofs. `R <- S` imports I_S, leaves D hard-stale, removes/declines R's proofs, and authors no I_R. Any validation that observed I_S remains capable of clearing exactly that authority.

Soft-after-validation trace: B's D is fresh under V1. A later authors soft S2 after an input becomes stale without changing its ValueRevision, retaining D's proofs. `B <- A` finds V1 does not cover S2, so D is stale-soft, retains coherent proofs, and authors no hard invalidate.

Local-hardening trace: A propagated soft I0 and remains cache-revalidatable. A receive discovers final-input incoherence requiring proof removal, while no uncovered hard barrier represents that reason. It authors one hard I1. Reverse receive imports I1 unchanged. Later receives enforce it silently until one validation individually clears it.

### 7. Atomic installation and no-op

Install graph, journal, journal coverage, and allocator atomically. Apply componentwise coverage union from the journal sync specification. An imported precise event is sufficient evidence; receipt alone is silent. Pure copying authors no add/edit and does not alter `modifiedAt`. Settled equivalent states with no newer source coverage append nothing.

## Storage, validation, and lifecycle safety

The merge algebra above does not weaken storage safety. A bilateral merge uses
read-only fixed snapshots L and H and constructs inactive target T. L remains
active and unmodified until T is complete, durable, and validated.

### Input validation and identifier reconciliation

Before planning, synchronization MUST reject atomically:

1. schema-version mismatch;
2. an unparseable identifier lookup;
3. one `NodeIdentifier` mapped to different semantic keys;
4. duplicate or internally conflicting lookup entries;
5. a value, freshness, timestamp, or validity record whose identifier is not
   covered by its source lookup;
6. retained journal entries which cannot be structurally interpreted, including
   edit/invalidate/validate without a
   generation resolving to a same-key GenerationJournalEntry witness; a generation whose named initial freshness event differs in author/key/generation, is not validate/invalidate, or does not have a greater sequence; or malformed/noncanonical `clearsThrough` coordinates;
7. the local coverage coordinate differs from `localJournalClock`, or local authoring failed to allocate above transaction-observed history;
8. one JournalEntryId naming different immutable contents;
9. journal coverage below a surviving entry sequence; or
10. non-monotone or malformed journal coverage, or a retained comparable validation pair whose later `clearsThrough` regresses.

When evidence is simultaneously available, an implementation MAY additionally
reject conflicting immutable content at one `JournalEntryId`. The mandatory
validation-monotonicity check applies whenever a comparable retained pair is
available; canonical compaction need not preserve discarded history solely to
make an otherwise impossible comparison. These checks diagnose corrupted or
unsupported input rather than proving lifecycle legitimacy.

Before journal join or conflict planning, validate each source against its own
pre-merge journal. Every source materialization MUST resolve its source presence
generation, a current value origin (the GenerationJournalEntry itself or a scoped edit) matching its `modifiedAt`,
and the exact `canonicalEvent` selected from the admissible winning-generation
per-author value heads. A superseded same-author event or lower equal-time event
is not a valid origin even when its bytes and time match. Its source
freshness and validity must agree with the effective-validation barrier for N,G
and ordinary graph invariants. Failure is corrupt source state and rejects that
source merge; it MUST NOT be converted into an unusable candidate, absence, or a
new destructive entry.

Different identifiers for the same semantic key are expected, not corruption.
For a surviving selected candidate, its source identifier is preferred. If the
same selected `ValueRevision` is available under multiple identifiers, choose
the least `NodeIdentifier` in canonical byte order. This rule is symmetric and
uses the allocating fingerprint already contained in `NodeIdentifier`; no new
host discriminator is added. The final lookup is a bijection between surviving
semantic keys and final identifiers. All structural input edges are relowered
from the fixed graph scheme through this final lookup.

### Deletion closure

A deletion root expands through every transitive materialized dependent in the
structural semantic DAG, not merely through `valid`. For `A,B -> D -> E -> F`,
deleting D deletes cached D, E, and F while preserving A, B, siblings, and
unrelated nodes. Deleted keys retain no final identifier, value, freshness,
timestamp, or validity record. Synchronization invokes no computor while
building this closure.

Resolve winning presence roots, compute the complete transitive closure, and remove closed-over dependents before value/proof reconciliation. For each newly derived dependent absence lacking an applicable winning delete, the receiver authors exactly one delete after the transaction-observed journal watermark with `time=τreceive`. A later reverse receive imports that immutable delete silently. Only closure survivors enter value selection, so no reconciliation step may index an absent final input.

### Mandatory pre-cutover validation

Before T can become active, validate all of the following:

1. every value, freshness, timestamp, validity key, and validity dependent is
   covered by the final identifier lookup and is materialized where required;
2. every surviving materialization has exactly one identifier and complete
   value, freshness, and timestamp records;
3. the identifier lookup is internally consistent and bijective;
4. every validity edge is a structural dependency edge in the final graph;
5. every fresh node has a value, all distinct direct inputs materialized and
   fresh, and a validity flag from every direct input;
6. every retained validity proof passed extensional semantic proof transport against all final input/output values;
7. no losing or deleted identifier remains in any graph sublevel;
8. every materialized value resolves to the canonical current journal event;
9. presence and generation-scoped freshness agree with the installed journal
   frontiers; and
10. the allocator and monotone journal-coverage invariants hold.

Failure of any check aborts that source merge, leaves the active pointer
unchanged, and exposes no partial target. Graph merge and long validation run in
inactive storage, not by broadening the active-replica darkroom.

### Cutover and sequential sources

T becomes active whenever authoritative graph state, journal contents or journal coverage changes; a journal-only import therefore still
uses durable inactive construction and atomic pointer cutover. Cutover may be
skipped only when all three are unchanged.

Normal synchronization may process multiple source snapshots sequentially,
regardless of how a transport discovers or delivers them. Each source merge
reads the active result of prior successful merges, validates its own complete
result before cutover, and cleans its staging storage afterward. A failed source
is recorded and does not roll back successful sources; processing may continue
and failures are reported together. This sequential lifecycle does not imply
multi-source associativity, order independence, or all-to-all communication,
and it requires no repository, branch, or other transport-specific container.

Controlled reset is not this merge algorithm. Observed semantic reset retains receiver journal/coverage, does not import source history, constructs the source SemanticGraph atomically, and records causal-prefix stabilization for consumed history. Equal present values create no generation/value event; unequal present values use a scoped edit at reset time. Full reset and absorption rules are in the lifecycle specification.

## Required traces

### Ordinary cross-host wall-time ordering

A edits K at `modifiedAt=10:00` with unrelated journal sequence 500. B edits K
at `modifiedAt=10:01` with sequence 20. B wins because wall time is the primary
value-order coordinate. A's larger journal sequence does not override the later
wall-clock timestamp.

### Timestamp collisions

A makes two actual edits at wall time `t`. Its journal allocator produces 40 and
41, so the distinct sequences keep `[t,41,A]` and `[t,40,A]` distinct and the
sequence-first canonical event is 41. Independently A and B may each edit at
`t`; sequence decides first and author breaks an equal-sequence tie. No
physical-host or hash tie-break is needed.

For `X -> D`, suppose A and B edit D at the same `t`, A's D is coherent with the
winning X, and B's D is unsupported, while B's event is canonical. A's D cannot
be chosen and mislabeled as B's revision. B's candidate is retained stale under
the one-input fallback. With multiple inputs, the unsafe collision is deleted
and receives a durable delete barrier.

### Unsupported clock rollback

K has an observed value at `modifiedAt=12:00`. A later actual edit on a skewed
host receives `modifiedAt=11:59`. This violates the synchronized-wall-clock
assumption and is unsupported: synchronization correctness and value-selection
guarantees do not apply. Neither journal sequence nor any other synchronization
mechanism repairs this execution.

### Concurrent presence generations

A adds root K as VA at `(10,A)` and wall time 200. Concurrently B, after
unrelated journal activity, adds VB at `(50,B)` and wall time 100. Presence is
resolved first to B's generation. VA is not a candidate inside that
generation, so its wall time cannot override the presence decision; final K is
VB with revision `[100,50,B]`.

### Losing-generation edit collision

G1 is old and G2 is the newer winning generation. A carries D on G1 with edit
`E1=(author=A,modifiedAt=T,generation=G1)`. B carries D on G2 with event
`E2=(author=B,modifiedAt=T,generation=G2)`, and A sorts above B. Joined presence
selects G2, so E1 is inapplicable before the author tie-break.
`canonicalEvent(D,G2)` considers only G2 events and selects E2. No conservative
delete occurs merely because a losing generation used the same timestamp.

### Causally later equal-time edit

A authors `E1=(sequence=10,author=A,generation=G,time=T)`. B synchronizes A and
then genuinely changes D in G, authoring
`E2=(sequence=11,author=B,generation=G,time=T)`. Wall time need not advance.
Even when A sorts above B, sequence-first `canonicalEvent(D,G)` selects E2 in
B's reachable post-transaction snapshot. Only truly concurrent equal-sequence
events use author as the deterministic tie-break.

### Value through a carrier

A authors `(sequence=12,author=A,key=K,action=edit,generation=G)`. A to B imports that exact entry and value; B to C transmits the same identity without renumbering. Receipt is silent. All hosts derive the same `[time,12,A]`, so support survives physical movement. Neither B nor C emits edit, and polling compares sequence 12 with the consumer's A coordinate regardless of carrier.

### Same-writer later edit

H1 carries A's edit 12 while joined history makes A's edit 18 the `valueHead`.
H1's bytes do not resolve to a current candidate and cannot resurrect, even if
their wall time would otherwise win.

### Delete barrier and connected chain

In chain H1—H2—H3, H1 carries unsupported multi-input D revision r1, H2 carries
incompatible r2, and H3 is absent. H1—H2 deletes D and H2 authors delete q after
both histories. H2—H3 propagates q without another delete. H3's absence never
accepts an unsupported D, and when q reaches H1 neither r1 nor r2 can cross it.
The former spread → collide → disappear → spread cycle terminates without an
H1—H3 edge.

### Invalidation barrier

A has old generation G1 and validate `V=(100,A,generation=G1)`. B establishes
winning `G2=(20,B)` and invalidates it with
`I=(21,B,generation=G2)`. C carries fresh/coherent G2 bytes and old incoming
proofs. V is ignored for G2. No validation for G2 covers I, so C's proofs are not transported. A later normal recomputation that observes I,
proves exact G2 inputs, and emits validate V2 scoped to G2 may restore freshness.

### Unchanged

D at revision `[t,7,A]` was supported by input revisions `[a1,b1]`. Inputs become
`[a2,b2]`; normal recomputation returns `Unchanged` and restores both valid
flags. D remains `[t,7,A]`, while transient `Support(D)` is now `[a2,b2]`.

### Compaction

A's edit 3 is covered by edit 9 for the same key/action. Retaining edit 9 keeps
polling coverage. Non-null public-action coordinate maxima preserve obligations; the separate canonical `presenceHead` GenerationJournalEntry/delete survivor preserves current presence. For
value and freshness authority, compaction additionally retains the greatest edit
and invalidate/validate per author scoped to winning G, plus their generation witnesses, initial-freshness references, and causal closure under the exact canonical algorithm.
It may discard authority for losing generations because they can never win
later. The merge result is unchanged.

## Properties

### Reachable-state value invariant and total order

Induct over allowed transitions. Atomic add establishes G; atomic edit names its
resolved current G and introduces one unique `JournalEntryId` at its real
`modifiedAt`. `Unchanged` changes neither.
Synchronization copies this pair unchanged; delete removes it and invalidate
changes only freshness. Hence equal admissible `ValueRevision`s imply equal
values. Lexicographic ordering distinguishes different time, simultaneous
writers, and repeated same-writer/same-time changes, so admissible candidates
have a deterministic strict total order.

### Pairwise symmetry, absorption, and settled idempotence

Presence/freshness heads, candidate sets, coherence predicates, and maximum
selection are symmetric functions of A and B. Thus semantic selection is
argument-order independent. After a peer learns a destructive frontier that
sorts above a particular positive candidate, that candidate is inadmissible;
resynchronizing that old snapshot cannot undo the result. A previously unseen
concurrent positive entry with a greater ID is a distinct LWW event and may
supersede it. Equivalent settled inputs have identical heads and
classifications, so no transition or reconciliation entry is generated.

Journal merge is associative, but this specification deliberately does
**not** claim that full graph merge is associative or confluent. Eventual
agreement in one fair execution is not a unique schedule-independent join of
all histories. A settled cache may depend on schedule, but every allowed result
satisfies IncrementalGraph correctness.

## Eventual consistency theorem

**Theorem.** Let a finite set of writable hosts share one fixed finite schema and
finite materialized dependency DAG. Suppose ordinary graph mutation becomes
quiescent and every host satisfies the synchronized-wall-clock assumption above.
Executions containing clock skew or rollback are excluded. Let there be a fixed
connected undirected neighbor graph. For every
neighbor edge `{A,B}`, require both directed receive operations `A <- B` and
`B <- A` infinitely often (**directional fairness**). A receive stages the
sender's published snapshot and installs a validated result only at the receiver;
the sender remains read-only. Then repeated bilateral
synchronization eventually makes every host's graph observably equivalent, and
all later synchronizations make no graph change.

No leader, distinguished host, or all-to-all edge is assumed.

Directional fairness is also what guarantees destructive transition authorship.
If an absent receiver sees an unsupported remote cache, it remains absent and
authors no delete because the closed classifier observes no local transition.
The reverse receive eventually occurs: the materialized endpoint receives the
absent/incompatible state, performs `materialized -> absent`, and authors the
delete. A merely undirected count of edge invocations would not suffice.

### A. Finite positive history

After quiescence synchronization runs no computor, so it creates no
`ComputedValue` and no computation-derived add, edit, or validate provenance.
There are finitely many starting hosts, materializations, value revisions,
presence generations, validity relations, and thus transient support
configurations. Synchronization only propagates these positive candidates or
removes their admissibility.

### B. Destructive progress terminates

Let P be the finite set of retained positive GenerationJournalEntry/value/freshness authorities and proofs
present at quiescence. A new destructive entry b is allocated above every entry
observed by that receive, so it LWW-dominates at least one offending positive p
that caused the decision. Charge the decision to `(receiver,p)`. That exact p
cannot cross b at that receiver again, and propagation of b authors nothing.

A previously unseen concurrent positive p2 may have a greater ID and cross b;
this does not contradict the LWW rule. When p2 later causes another destructive
decision, the new entry is allocated above p2 and is charged to the distinct
finite pair `(receiver,p2)`. A receiver already absent or stale does not author
the same transition again. Since `Hosts × P` is finite, only finitely many such
charges and genuinely new destructive entries occur. This is the well-founded
measure; the proof does not assume that Lamport order implies observation.

### C. Journal gossip converges

After the final entry in the supported execution described by this theorem,
logical merge is commutative, associative, and idempotent.
For any retained entry and any target host, connectedness gives a finite path;
directional fairness eventually carries the entry through receives oriented
along that path. With finitely many entries and hosts, eventually every host has
every retained coordinate maximum and current-generation value/freshness
authority witness. Compaction preserves all projections, so generation-scoped
value, presence, and freshness frontiers stabilize identically everywhere.
Transport arrival order is semantically inert. Immutable precise entries gossip under their original identities, while coverage vectors converge by componentwise maximum.

### D. DAG induction

Proceed by dependency depth. Roots have no support condition and converge to the
deterministic greatest admissible revision, subject to the common presence
barrier. Directionally fair connected gossip propagates its bytes along paths.

Assume every direct input of N has stabilized. Every N candidate now has a fixed
classification: coherent, unsupported, or absent. If a coherent candidate
exists, the greatest coherent revision propagates along connected paths because support is existing extensional proof over equal semantic input/output values, not carrier or revision identity. If none
exists, the deterministic one-input stale fallback propagates; incompatible
multi-input candidates collapse to absence/delete, and unsupported-plus-absent
cannot re-expand beyond the stabilized delete frontier. Freshness follows the
common frontier and extensional coherent-proof rule. Thus N stabilizes. Induction
through the finite DAG establishes equivalent values, presence, freshness,
timestamps, identifiers up to semantic lookup, and validity relations at every
host. Settled idempotence then makes every further synchronization a graph no-op.
Once graph, journal history and coverage propagation settle, raw occurrence receipt is silent and no journal, allocator, or coverage changes. Repeated synchronization is a fixed point.
