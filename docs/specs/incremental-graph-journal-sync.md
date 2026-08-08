# Logical journal synchronization

## Merge

Only immutable logical entries replicate. Local cursor indexes, delivery heads,
watermarks, and gaps do not.

```text
J1 ⊔ J2 = compact(entries(J1) ∪ entries(J2))
```

Inputs must have the same journal domain/schema, valid durable authors, valid
actions and keys, and unique content for every `JournalEntryId`. Two entries
with one ID but different content are corruption and reject the operation
atomically and symmetrically. Remote entries never transfer author ownership.

The receiver imports an entry unchanged. If it has not delivered that logical
entry locally, it allocates a new physical cursor record. This makes learned
history observable without turning the receiver into its author.

## ACI proof

For each `(author,key,action)` coordinate, compacted union selects the entry of
maximum sequence. Validity makes that maximum unique. Set union is commutative,
associative, and idempotent, and coordinate-wise maximum has the same laws.
Canonical ordering is a representation function. Therefore logical merge is:

```text
J1 ⊔ J2 = J2 ⊔ J1
(J1 ⊔ J2) ⊔ J3 = J1 ⊔ (J2 ⊔ J3)
J ⊔ J = J
```

These laws apply to logical journal merge, not to the complete graph merge.

After accepting a peer journal, a writable host durably raises
`localJournalClock` to at least the greatest observed sequence before allocating
another entry. This watermark update and later allocations are serialized by
the journal-clock mutex. It does not alter imported entries.

## Virtual projections

For materialized semantic key `x`:

```text
valueHead(author,x) = greatest retained add/edit entry by sequence

candidateEvents(x) = E such that
    E.key == x && E.action in {add,edit} &&
    E.time == graph.timestamps[x].modifiedAt &&
    E == valueHead(E.author,x)

origin(x) = greatest candidate under (E.author,E.sequence)
ValueRevision(x) = [modifiedAt(x), origin(x).author, origin(x).sequence]
```

The author-first ordering used only to resolve candidate provenance is distinct
from `JournalEntryId` ordering. If no candidate exists, the materialization is
provenance-obsolete/unusable; synchronization never invents one.

```text
presenceHead(x) = greatest add/delete entry by JournalEntryId
generation(x)   = presenceHead(x) when its action is add
freshnessHead(x)= greatest invalidate/validate entry by JournalEntryId
                  occurring after generation(x)
```

A delete head bars older adds. A later real add authored after observing it
starts a new generation. An invalidate head bars older freshness proofs. A
validate head permits freshness only when current graph validity evidence is
coherent. With no post-add freshness entry, the generation's initial graph
freshness applies.

Compaction preservation is proved in the compaction specification.

## Stable value identity invariant

In every reachable snapshot, two admissible materializations with equal
`ValueRevision` have equal `ComputedValue`:

* Base case: an atomic add/edit authors one entry and commits exactly its value
  and real `modifiedAt`; one author never reuses the sequence.
* Local step: a value change receives a fresh sequence, so equality with the old
  revision is impossible. `Unchanged` retains both value and provenance.
* Copy step: synchronization copies an existing value and its unchanged origin
  entry, so equal revision retains equal bytes/value.
* Destructive step: delete removes the candidate and invalidate changes no
  value. Neither creates a counterexample.

Thus `ValueRevision` is collision-free over reachable admissible states. Its
lexicographic tuple is a strict deterministic total order: timestamps decide
first, different simultaneous authors second, repeated same-author changes at
one timestamp third. Equal revision with unequal values is corruption, not a
hash tie-break case.

## Traces

* **Same writer/time:** A's edits at wall time 100 receive sequences 7 and 8;
  `[100,A,8]` wins.
* **Concurrent writers/time:** A and B each edit at 100. Author order chooses
  between `[100,A,n]` and `[100,B,m]`; no source-host tie-break is involved.
* **Carrier independence:** A's `[100,A,8]` travels A → B → C. B and C import
  the entry and allocate local delivery positions but author no edit. All three
  compare the same revision.
* **Same-writer supersession:** A's retained head is edit 12. A host carrying
  A's edit 8 cannot resolve it as a candidate, even if its timestamp is large;
  it cannot resurrect.
