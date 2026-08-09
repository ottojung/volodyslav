# IncrementalGraph synchronization specification

## Scope and state boundary

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
The logical journals are joined first. Nodes are then processed in schema DAG
topological order, and the reconciled graph and joined/locally extended journal
commit atomically. Invalid graph/journal combinations outside reachable
transitions are corruption, not conflicts for which this protocol invents data.

## Guarantees and deliberate limits

Synchronization provides stable retained-journal identity for represented value
versions, deterministic timestamp-collision resolution, presence generations,
generation-scoped freshness barriers, and coherence decisions from the evidence
available in its two reachable source snapshots and retained logical history.
Insufficient evidence is handled conservatively. Synchronization invokes no
computor and invents no `ComputedValue`; journal merge is ACI; bilateral gossip
is decentralized; journal notifications have no action-specific false
negatives; and fully compacted journal storage is `O(nr²)` under the journal size model; uncompacted storage may grow with operations.

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

Synchronization assumes that system wall clocks are monotone over
IncrementalGraph operations on every supported host. Wall-clock timestamps are
the closest available approximation of a universal temporal order between
operations performed on different hosts and are therefore the primary
cross-host coordinate within `ValueRevision` ordering among candidates still
eligible at the relevant selection stage. This does not make wall time a global
override of presence-generation applicability, collision canonicalization,
coherence classification, or fallback rules.

Wall-clock timestamps have finite resolution and are not injective: distinct
value-changing operations may receive exactly equal timestamps. The journal
identity deterministically disambiguates those collisions. Clock rollback or
any other violation of these assumptions is outside the supported execution
model and gives undefined synchronization behavior. Synchronization does not
attempt to repair it.

This specification uses the definitions in the journal synchronization spec:

```text
ValueRevision(x,G) = [modifiedAt(x), modifiedBy(x,G), modifiedAtVirtual(x,G)]
modifiedBy(x,G) = origin(x,G).author
modifiedAtVirtual(x,G) = origin(x,G).sequence

presenceHead(x) = greatest add/delete by (sequence,author)
invalidateFrontier(x,G)[A] = greatest invalidate by A scoped to G
effectiveValidate(V,x,G) iff V alone covers every frontier element
```

A value event for winning generation G is usable only when it is add G or an
edit explicitly scoped to G, its time equals graph `modifiedAt`, and it is
`valueHead(author,x,G)`. An unresolvable, superseded, or differently scoped
materialization is provenance-obsolete. `ValueRevision(x,G)` is compared
lexicographically and totally. Equal revisions with unequal `ComputedValue`s
violate the reachable-state invariant; synchronization rejects corruption and
does not add a hash tie-break.

These are distinct orders:

```text
ValueRevision ordering:
    modifiedAt first, as approximate cross-host real-time order

canonical provenance among events with equal modifiedAt:
    JournalEntryId = (sequence,author)
```

Thus `modifiedBy` and `modifiedAtVirtual` provide exact deterministic identity
when finite-resolution wall times collide. `modifiedAtVirtual` does not replace
wall time and is not intended to repair a non-monotone system clock.
For `T1 < T2`, T2 wins regardless of journal sequences. At equal T, distinct
writer fingerprints distinguish cross-host revisions, while the journal
sequence distinguishes repeated same-writer changes and selects the canonical
event under sequence-first `JournalEntryId`. No hash or value-equality fallback
is used as revision identity.

For an exact `modifiedAt` collision inside G, the greatest matching event by
`JournalEntryId=(sequence,author)` is canonical. A source candidate resolves its
alleged event from its own pre-merge reachable snapshot and is admissible after
journal join only if that event is `canonicalEvent(x,G)`. Selection MUST NOT keep another
tied candidate and attribute the canonical event to it. If the canonical
candidate is unsupported, lower tied coherent candidates are excluded and the
conservative no-coherent rule applies.

A delete presence head prevents lower-ordered add generations from resurrecting.
A greater add may rematerialize under LWW order whether causally later or
concurrent with unrelated high Lamport history. If
the joined head says present but no source carries usable bytes for that
presence generation, the result is absent; a genuinely new decision emits a
delete barrier.

For final add generation G, every per-author invalidate is an independent barrier. A validation permits journal freshness only if its immutable `clearsInvalidates` context names the exact frontier invalidate (or a later same-author invalidate) for every author. Numeric entry order is not observation and contexts from separate validations MUST NOT be combined. Even one effective validation only permits freshness when ordinary exact graph validity is coherent. Other-generation contexts have no authority.

## Transient support

For derived node `D` and source snapshot `S`, let its distinct direct semantic
inputs be `I1...Ik`. Duplicate input positions collapse exactly as existing
`inputEdges`/`valid` semantics require.

```text
SupportS(D) is known iff S.valid[Ii].has(D) for every distinct Ii
SupportS(D) = [ValueRevisionS(I1,G1), ..., ValueRevisionS(Ik,Gk)]

coherentS(D) iff SupportS(D) is known &&
                   SupportS(D) == FinalInputRevisions(D)
```

The vector is derived for the operation and never persisted. Missing validity
makes support unknown. Deep value equality does not create proof. Because input
revisions identify originating journal events rather than source containers, a
value copied through another host has the same support identity.

`SupportS(D)` is evidence derivable from S about D's currently retained cached
value. It is not a record of every input revision D has incorporated, historical
computation provenance, proof that no earlier coherent history existed when
support is unknown, or a complete history of `Unchanged` revalidations. Unknown
support means only that this synchronization cannot establish coherence from
the evidence represented by this specification; it does not prove that D was
historically incoherent.

`Unchanged` preserves D's add/edit provenance. Normal recomputation may restore
its current `valid` edges against newer inputs, so transient support changes
without any metadata or new edit on D.

## Symmetric pairwise graph merge

The following rules depend only on the two source snapshots and canonical total
orders. Therefore the semantic graph decision is independent of argument order;
local paths, inactive slots, cursor positions, and the author chosen to record a
new destructive fact are physical commit details.

### 1. Presence

Apply joined presence history first. Discard any materialization whose add
generation predates the newest applicable delete. If final presence is absent,
delete the node and maintain dependency-closure deletion. Do not spread a
materialization when no usable source carries the current add generation.

If the joined `presenceHead(N)` is add G, derive each candidate's source
generation from its source pre-merge `presenceHead(N)` and admit it only when
that generation equals G. This applies to concurrent adds as well as adds around
deletes. Value ordering and coherence selection occur only inside G; they cannot
select bytes from a losing presence generation.

Only add G and edits explicitly scoped to G participate in G's value heads.
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
candidate as coherent or unsupported using its own source proof and the exact
final input revisions. If coherent candidates exist, choose the coherent
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

Never union `valid`. Rebuild incoming validity edges only from a coherent source
proof against the exact final direct-input revisions. A stale fallback retains
no incoming proof not established coherent. Structural dependency edges come
from the graph scheme, never from `valid`.

If no single validation covers the complete `invalidateFrontier(N,G)`, N is a direct
invalidation root: final N is stale and synchronization transports **no incoming
validity proofs into N**, even if an older fresh source is otherwise coherent.
This applies equally to locally and synchronization-authored invalidations. A
later normal pull must recompute or revalidate through the normal graph rules
before it may emit `validate` and restore incoming proofs.

### 6. Freshness

A selected node is final-fresh only if:

1. one applicable validation individually covers the complete `invalidateFrontier(N,G)` when that frontier is nonempty;
2. selected-source validity is coherent with exact final inputs; and
3. every ordinary clean-node invariant holds.

Otherwise it is stale. Whenever synchronization removes or declines incoming
proofs in a way that newly makes a materialized N require genuine normal
recomputation/revalidation, it establishes hard invalidation. This includes
fresh→stale demotion and stale→stale hardening of a propagated-stale cache whose
incoming proofs had still permitted cache-only revalidation. The transaction
MUST author exactly one invalidate for G after all observed journal history,
unless an entry installed or authored by this same causal decision already
represents that exact new obligation. It never synthesizes validate.

Synchronization does not author endless barriers for a settled node. If N was
already hard-invalidated before the transaction, its proofs remain absent, and
the retained frontier already contains the outstanding barrier representing
that obligation, synchronization merely carries that barrier. No new hardening
decision occurred. Conversely, removing proofs during this transaction is a new
decision even if an older frontier barrier exists: that older barrier may have
been cleared on an unseen host and cannot represent the later proof-removal
decision.
A validation which did not observe the barrier cannot cross it, regardless of ID; a later genuine normal revalidation may author validate scoped to G with the complete observed frontier.

That synchronization-authored invalidate explicitly carries G. Entries for
other generations neither satisfy nor override this barrier.

Trace: A has propagated I0, is stale, and retains incoming proofs. B observes I0,
cache-revalidates, and authors V0 clearing I0. A has not seen V0. Synchronizing A
with C (which also lacks V0) finds no effective validation and removes N's
incoming proofs. Although freshness remains stale, this is hardening, so the
transaction authors I1 above all observed history. Later union with B includes
I1; V0 does not cover I1, and N remains stale until genuine validation after
observing I1.

### 7. Atomic installation and no-op

Install the joined journal, any newly derived destructive entries, graph result,
identifier lookup, timestamps, freshness, and validity in one transaction.
Pure copying authors no add/edit and does not alter `modifiedAt`. Synchronizing
settled equivalent states performs no graph transition and authors no entry.
For every key whose graph changes, a newly installed/authored same-key entry
supplies a fresh local index; otherwise touch the greatest retained same-key
`notificationWitness`. Touch each changed key once, including every dependent
changed by deletion closure or propagated invalidation. Touch changes only the
stored local index and commits atomically with the graph. Settled equivalent
states learn nothing, author nothing, touch nothing, and advance neither
watermark.

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
6. malformed journal entries, including edit/invalidate/validate without a
   generation resolving to a same-key add witness; a validation causal
   reference which is absent, mismatched, or not sequence-earlier than the
   validation; or same-author/key/generation validations whose later context
   forgets or moves an earlier coordinate backward;
7. conflicting content at one `JournalEntryId`; or
8. `localJournalClock` below an observed sequence;
9. a retained entry missing exactly one unique valid local index;
10. `localJournalIndexWatermark` below a retained local index; or
11. any use of local index in logical equality, provenance, or merge.

Before journal join or conflict planning, validate each source against its own
pre-merge journal. Every source materialization MUST resolve its source presence
generation, a current generation-scoped value event matching its `modifiedAt`,
and a `ValueRevision` whose event belongs to that generation. Its source
freshness and validity must agree with the effective-validation barrier for N,G and ordinary graph
invariants. Failure is corrupt source state and rejects that host merge; it MUST
NOT be converted into an unusable candidate, absence, or a new destructive
entry.

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
6. every retained validity proof passed the exact final-`ValueRevision` support
   check;
7. no losing or deleted identifier remains in any graph sublevel;
8. every materialized value resolves to the canonical current journal event;
9. presence and generation-scoped freshness agree with the installed journal
   frontiers; and
10. both journal watermarks and all local-index uniqueness/inertness invariants
    hold.

Failure of any check aborts that host merge, leaves the active pointer unchanged,
and exposes no partial target. Graph merge and long validation run in inactive
storage, not by broadening the active-replica darkroom.

### Cutover and sequential hosts

T becomes active whenever authoritative graph state, logical journal contents,
or receiver-local entry indexes change; a journal-only import therefore still
uses durable inactive construction and atomic pointer cutover. Cutover may be
skipped only when all three are unchanged.

Normal synchronization may process multiple host branches sequentially. Each
host merge reads the active result of prior successful merges, validates its own
complete result before cutover, and cleans its staging storage afterward. A
failed host is recorded and does not roll back successful hosts; processing may
continue and failures are reported together. This sequential lifecycle does not
imply multi-host associativity, order independence, or all-to-all communication.

Controlled reset is not this merge algorithm. It imports source history, then
performs receiver-authoritative re-generation. Every target-materialized key
receives a fresh receiver add generation above all observed history; target
absence receives a later delete. Value-changing reset uses real reset wall time,
while equal-value re-generation preserves `modifiedAt`. The lifecycle
specification defines the complete reset procedure and DAG validation.

## Required traces

### Ordinary cross-host wall-time ordering

A edits K at `modifiedAt=10:00` with unrelated journal sequence 500. B edits K
at `modifiedAt=10:01` with sequence 20. B wins because wall time is the primary
value-order coordinate. A's larger journal sequence does not override the later
wall-clock timestamp.

### Timestamp collisions

A makes two actual edits at wall time `t`. Its journal allocator produces 40 and
41, so the distinct sequences keep `[t,A,41]` and `[t,A,40]` distinct and the
sequence-first canonical event is 41. Independently A and B may each edit at
`t`; sequence decides first and author breaks an equal-sequence tie. No
physical-host or hash tie-break is needed.

For `X -> D`, suppose A and B edit D at the same `t`, A's D is coherent with the
winning X, and B's D is unsupported, while B's event is canonical. A's D cannot
be chosen and mislabeled as B's revision. B's candidate is retained stale under
the one-input fallback. With multiple inputs, the unsafe collision is deleted
and receives a durable delete barrier.

### Unsupported clock rollback

K has an old value at `modifiedAt=12:00`. A later actual edit after system-clock
rollback receives `modifiedAt=11:59`. This violates the monotone-clock
assumption and has undefined synchronization semantics. Neither journal sequence
nor any other synchronization mechanism repairs this unsupported execution.

### Concurrent presence generations

A adds root K as VA at `(10,A)` and wall time 200. Concurrently B, after
unrelated journal activity, adds VB at `(50,B)` and wall time 100. Presence is
resolved first to B's add generation. VA is not a candidate inside that
generation, so its wall time cannot override the presence decision; final K is
VB with revision `[100,B,50]`.

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

A authors `(A,12,K,edit,t,generation=G)`. A → B imports that entry and value; B
stores it once with a fresh local index. B → C transmits only the immutable
entry, and C assigns its own index. All
hosts derive `[t,A,12]`, so support referring to K survives physical movement.
Neither B nor C emits edit.

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

D at revision `[t,A,7]` was supported by input revisions `[a1,b1]`. Inputs become
`[a2,b2]`; normal recomputation returns `Unchanged` and restores both valid
flags. D remains `[t,A,7]`, while transient `Support(D)` is now `[a2,b2]`.

### Compaction

A's edit 3 is covered by edit 9 for the same key/action. Retaining edit 9 keeps
notification coverage. Add/delete coordinate maxima preserve presence. For
value and freshness authority, compaction additionally retains the greatest edit
and invalidate/validate per author scoped to winning G, plus their add witnesses.
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

Logical journal merge is associative, but this specification deliberately does
**not** claim that full graph merge is associative or confluent. Eventual
agreement in one fair execution is not a unique schedule-independent join of
all histories. A settled cache may depend on schedule, but every allowed result
satisfies IncrementalGraph correctness.

## Eventual consistency theorem

**Theorem.** Let a finite set of writable hosts share one fixed finite schema and
finite materialized dependency DAG. Suppose ordinary graph mutation becomes
quiescent and every host satisfies the monotone-wall-clock assumptions above.
Executions containing clock rollback are excluded. Let there be a fixed
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

Let P be the finite set of positive add/edit/validate generations and proofs
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

After the final entry, logical merge is commutative, associative, and idempotent.
For any retained entry and any target host, connectedness gives a finite path;
directional fairness eventually carries the entry through receives oriented
along that path. With finitely many entries and hosts, eventually every host has
every retained coordinate maximum and current-generation value/freshness
authority witness. Compaction preserves all projections, so generation-scoped
value, presence, and freshness frontiers stabilize identically everywhere.
`localIndex` is semantically inert: changing it affects none of `JournalEntryId`,
the three heads, canonical event, value revision, generation, admissibility,
coherence, or graph merge. Only immutable entry contents gossip.

### D. DAG induction

Proceed by dependency depth. Roots have no support condition and converge to the
deterministic greatest admissible revision, subject to the common presence
barrier. Directionally fair connected gossip propagates its bytes along paths.

Assume every direct input of N has stabilized. Every N candidate now has a fixed
classification: coherent, unsupported, or absent. If a coherent candidate
exists, the greatest coherent revision propagates along connected paths because
support names intrinsic journal-backed input revisions, not the carrier. If none
exists, the deterministic one-input stale fallback propagates; incompatible
multi-input candidates collapse to absence/delete, and unsupported-plus-absent
cannot re-expand beyond the stabilized delete frontier. Freshness follows the
common frontier and exact coherent proof rule. Thus N stabilizes. Induction
through the finite DAG establishes equivalent values, presence, freshness,
timestamps, identifiers up to semantic lookup, and validity relations at every
host. Settled idempotence then makes every further synchronization a graph no-op.
Once graph and logical history settle, no entry is learned or compacted and no
graph key changes. Therefore no touch occurs and receiver-local indexes and
watermarks also stop changing.
