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

canonicalEvent(x) = greatest candidate under (E.author,E.sequence)
origin(x) = canonicalEvent(x)
ValueRevision(x) = [modifiedAt(x), origin(x).author, origin(x).sequence]
```

The author-first ordering used only to resolve candidate provenance is distinct
from `JournalEntryId` ordering. If no candidate exists, the materialization is
provenance-obsolete/unusable; synchronization never invents one.

When multiple current value heads match one `modifiedAt`, the canonical event
is also an admissibility constraint, not merely a label inferred after value
selection. Each source candidate first resolves its alleged event in its own
reachable pre-merge snapshot. After journal join, only the candidate whose
alleged event equals `canonicalEvent(x)` may represent that timestamp. A lower
tied candidate cannot be selected and then labeled with the winner's event.

Consequently, if the canonical tied candidate is unsupported while a lower tied
candidate is coherent, synchronization does not keep the lower candidate. The
ordinary no-coherent rule applies to the canonical candidate: a one-input cache
may be retained stale, while incompatible multi-input history is deleted. This
is conservative only for exact wall-clock collisions and preserves recoverable
journal-only provenance.

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

For source snapshot `S`, `sourceGenerationS(x)` is its pre-merge
`presenceHeadS(x)` when that head is an add. Once the joined `presenceHead(x)`
selects add generation G, only materializations with
`sourceGenerationS(x) == G` are admissible value candidates. A source whose
generation is an older or concurrent losing add cannot supply bytes for G.
`ValueRevision` orders candidates only within this surviving presence
generation. Thus concurrent adds cannot combine one add's presence frontier with
another add's value.

Compaction preservation is proved in the compaction specification.

## Stable value identity invariant

In every reachable snapshot, two admissible materializations with equal
`ValueRevision` have equal `ComputedValue`:

* Base case: an atomic add/edit authors one entry and commits exactly its value
  and real `modifiedAt`; one author never reuses the sequence.
* Local step: a value change receives a fresh sequence, so equality with the old
  revision is impossible. `Unchanged` retains both value and provenance.
* Copy step: synchronization copies an existing value and its unchanged origin
  entry. Exact timestamp collisions admit only the canonical event's source
  candidate, so selection cannot attach another candidate's bytes to that ID;
  equal revision retains equal bytes/value.
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
  If B is the canonical event but B's derived cache is unsupported against final
  inputs, coherent A is not mislabeled as B: the result is stale fallback for
  one input or deletion for multiple inputs.
* **Concurrent adds:** A adds K at `(10,A)` with `modifiedAt=200`; B adds K at
  `(50,B)` with `modifiedAt=100`. Joined presence chooses B's generation, so A's
  bytes are inadmissible despite their later wall time. The result uses B's
  value and derives `[100,B,50]`; presence and value cannot name different
  generations.
* **Carrier independence:** A's `[100,A,8]` travels A → B → C. B and C import
  the entry and allocate local delivery positions but author no edit. All three
  compare the same revision.
* **Same-writer supersession:** A's retained head is edit 12. A host carrying
  A's edit 8 cannot resolve it as a candidate, even if its timestamp is large;
  it cannot resurrect.
