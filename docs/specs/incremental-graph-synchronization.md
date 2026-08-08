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

## Journal-derived frontiers

This specification uses the definitions in the journal synchronization spec:

```text
ValueRevision(x) = [modifiedAt(x), modifiedBy(x), modifiedAtVirtual(x)]
modifiedBy(x) = origin(x).author
modifiedAtVirtual(x) = origin(x).sequence

presenceHead(x)  = greatest add/delete by (sequence,author)
freshnessHead(x) = greatest post-generation invalidate/validate
                   by (sequence,author)
```

A value event is usable only when its time equals the graph `modifiedAt` and it
is the current add/edit `valueHead` for its author. An unresolvable or superseded
materialization is provenance-obsolete. `ValueRevision` is compared
lexicographically and totally. Equal revisions with unequal `ComputedValue`s
violate the reachable-state invariant; synchronization rejects corruption and
does not add a hash tie-break.

A delete presence head prevents older add generations from resurrecting. A later
normal add may rematerialize only when authored after observing that delete. If
the joined head says present but no source carries usable bytes for that
presence generation, the result is absent; a genuinely new decision emits a
delete barrier.

A post-generation invalidate prevents an older fresh proof from restoring
freshness. A later validate only permits freshness when normal graph validity
proof remains coherent. An add starts a new presence generation, so freshness
history before it does not constrain that generation.

## Transient support

For derived node `D` and source snapshot `S`, let its distinct direct semantic
inputs be `I1...Ik`. Duplicate input positions collapse exactly as existing
`inputEdges`/`valid` semantics require.

```text
SupportS(D) is known iff S.valid[Ii].has(D) for every distinct Ii
SupportS(D) = [ValueRevisionS(I1), ..., ValueRevisionS(Ik)]

coherentS(D) iff SupportS(D) is known &&
                   SupportS(D) == FinalInputRevisions(D)
```

The vector is derived for the operation and never persisted. Missing validity
makes support unknown. Deep value equality does not create proof. Because input
revisions identify originating journal events rather than source containers, a
value copied through another host has the same support identity.

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

### 2. Candidate resolution

For every surviving source materialization, resolve `ValueRevision` in that
source's pre-merge view after accounting for joined supersession. Discard
unresolvable/provenance-obsolete candidates. A source container is never part of
semantic identity.

For a zero-input node choose the candidate with greatest `ValueRevision`. This
is the complete root rule.

### 3. Derived coherence

Direct inputs have already reached their final selections. Classify each
candidate as coherent or unsupported using its own source proof and the exact
final input revisions. If coherent candidates exist, choose the coherent
candidate with greatest `ValueRevision`. A newer-timestamp unsupported candidate
never suppresses a coherent one.

### 4. No coherent candidate

* Zero distinct inputs use the root greatest-revision rule.
* One distinct input retains the greatest admissible candidate but makes it
  potentially outdated, preserving useful `oldValue` behavior.
* More than one distinct input is conservative:
  * the exact same revision on both sides may be retained stale;
  * different unsupported revisions are deleted;
  * one unsupported revision opposite absence is not spread into the hole and
    the result is absent/deleted.

A newly derived deletion authors one `delete` entry after every entry observed
by the operation. If a covering barrier already justifies the result, propagate
it without authoring another.

### 5. Validity reconstruction

Never union `valid`. Rebuild incoming validity edges only from a coherent source
proof against the exact final direct-input revisions. A stale fallback retains
no incoming proof not established coherent. Structural dependency edges come
from the graph scheme, never from `valid`.

### 6. Freshness

A selected node is final-fresh only if:

1. joined generation history contains no later invalidate barrier;
2. selected-source validity is coherent with exact final inputs; and
3. every ordinary clean-node invariant holds.

Otherwise it is stale. When synchronization newly demotes fresh to stale for a
reason not represented by a covering invalidate, it authors exactly one
`invalidate` after all observed journal history. It never synthesizes validate.
An old validate or old fresh peer cannot cross that barrier; a later genuine
normal revalidation after observing it may author validate.

### 7. Atomic installation and no-op

Install the joined journal, any newly derived destructive entries, graph result,
identifier lookup, timestamps, freshness, and validity in one transaction.
Pure copying authors no add/edit and does not alter `modifiedAt`. Synchronizing
settled equivalent states performs no graph transition and authors no entry.

## Required traces

### Timestamp collisions

A makes two actual edits at wall time `t`. Its journal allocator produces 40 and
41, so `[t,A,41] > [t,A,40]`. Independently A and B may each edit at `t`; their
author components deterministically differ, with sequence resolving repeated
same-author changes. No physical-host or hash tie-break is needed.

### Value through a carrier

A authors `(A,12,K,edit,t)`. A → B imports that entry and value; B allocates only
a local delivery cursor. B → C transmits the same entry. All hosts derive
`[t,A,12]`, so support referring to K survives physical movement. Neither B nor
C emits edit.

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

H1 has fresh D with old proof p. H2 derives invalidate q after p. Once H1 learns
q, p cannot restore fresh and repeat synchronization authors nothing. A later
normal recomputation that observes q, proves exact current inputs, and emits
validate v with `v.sequence > q.sequence` may restore freshness.

### Unchanged

D at revision `[t,A,7]` was supported by input revisions `[a1,b1]`. Inputs become
`[a2,b2]`; normal recomputation returns `Unchanged` and restores both valid
flags. D remains `[t,A,7]`, while transient `Support(D)` is now `[a2,b2]`.

### Compaction

A's edit 3 is covered by edit 9 for the same key/action. Retaining edit 9 keeps
A's value head at the newest revision. Likewise a later same-coordinate add,
delete, invalidate, or validate advances rather than lowers its relevant
presence/freshness projection. The merge result is unchanged by discarding the
covered entries.

## Properties

### Reachable-state value invariant and total order

Induct over allowed transitions. Atomic add/edit introduces one value and one
unique `(author,sequence)` at its real `modifiedAt`. `Unchanged` changes neither.
Synchronization copies this pair unchanged; delete removes it and invalidate
changes only freshness. Hence equal admissible `ValueRevision`s imply equal
values. Lexicographic ordering distinguishes different time, simultaneous
writers, and repeated same-writer/same-time changes, so admissible candidates
have a deterministic strict total order.

### Pairwise symmetry, absorption, and settled idempotence

Presence/freshness heads, candidate sets, coherence predicates, and maximum
selection are symmetric functions of A and B. Thus semantic selection is
argument-order independent. After a peer learns a destructive barrier, its old
positive candidate is inadmissible; resynchronizing the old snapshot cannot
undo the result (absorption). Equivalent settled inputs have identical heads and
classifications, so no transition or reconciliation entry is generated.

Logical journal merge is associative, but this specification deliberately does
**not** claim that full graph merge is associative or confluent. Eventual
agreement in one fair execution is not a unique schedule-independent join of
all histories. A settled cache may depend on schedule, but every allowed result
satisfies IncrementalGraph correctness.

## Eventual consistency theorem

**Theorem.** Let a finite set of writable hosts share one fixed finite schema and
finite materialized dependency DAG. Suppose ordinary graph mutation becomes
quiescent. Let there be a fixed connected undirected peer graph, and let every
edge be synchronized infinitely often (**fairness**). Then repeated bilateral
synchronization eventually makes every host's graph observably equivalent, and
all later synchronizations make no graph change.

No leader, distinguished host, or all-to-all edge is assumed.

### A. Finite positive history

After quiescence synchronization runs no computor, so it creates no
`ComputedValue` and no computation-derived add, edit, or validate provenance.
There are finitely many starting hosts, materializations, value revisions,
presence generations, validity relations, and thus transient support
configurations. Synchronization only propagates these positive candidates or
removes their admissibility.

### B. Destructive progress terminates

Let `P` be the finite set of pairs `(node, positive candidate generation/proof)`
present at quiescence. For each joined-history state, let measure `M` be the
subset of P still admissible somewhere across its known presence and freshness
barriers, ordered by strict set inclusion; refine it with the finite number of
hosts not yet carrying each already-created barrier.

A genuinely new sync-derived delete or invalidate is sequenced after all history
that caused it and makes at least one member of M permanently inadmissible to
any host that learns the barrier. That exact older generation/proof can never
cross the barrier. Propagating an existing barrier decreases only the finite
refinement and authors nothing. Because strict deletion from finite P is
well-founded, only finitely many genuinely new destructive decisions can occur.
A later positive generation could cross a barrier only through normal
add/edit/validate, which quiescence excludes. Therefore journal creation stops.

### C. Journal gossip converges

After the final entry, logical merge is commutative, associative, and idempotent.
For any retained entry and any target host, connectedness gives a finite path;
fair synchronization of each path edge eventually carries the entry along that
path. With finitely many entries and hosts, eventually every host has every
non-covered entry. Compaction preserves all projections, so value, presence,
and freshness frontiers stabilize identically everywhere.

### D. DAG induction

Proceed by dependency depth. Roots have no support condition and converge to the
deterministic greatest admissible revision, subject to the common presence
barrier. Fair connected gossip propagates its bytes along paths.

Assume every direct input of N has stabilized. Every N candidate now has a fixed
classification: coherent, unsupported, or absent. If a coherent candidate
exists, the greatest coherent revision propagates along connected paths because
support names intrinsic journal-backed input revisions, not the carrier. If none
exists, the deterministic one-input stale fallback propagates; incompatible
multi-input candidates collapse to absence/delete, and unsupported-plus-absent
cannot re-expand beyond the delete barrier. Freshness follows the common barrier
and exact coherent proof rule. Thus N stabilizes. Induction through the finite
DAG establishes equivalent values, presence, freshness, timestamps, identifiers
up to semantic lookup, and validity relations at every host. Settled idempotence
then makes every further synchronization a graph no-op.
