# Logical journal synchronization

## Merge

Only immutable logical entries replicate. Receiver-local `localIndex` values,
`localJournalIndexWatermark`, and harmless gaps do not.

```text
J1 ⊔ J2 = compact(entries(J1) ∪ entries(J2))
```

Inputs must have the same schema, valid durable authors, valid actions and keys,
and unique content for every `JournalEntryId`. Every edit/invalidate/validate
must carry a generation resolving to a valid same-key add in the validated merge
input. Two entries
with one ID but different content are corruption and reject the operation
atomically and symmetrically. Remote entries never transfer author ownership.

The receiver imports an unknown entry unchanged, stores it once, and assigns a
fresh local index. The sender's index is ignored. An already-known entry is not
moved merely because it was received again.

## ACI proof

Compaction retains every coordinate maximum plus, for the sole winning presence
generation G, the bounded value/freshness-authority witnesses defined in the
compaction specification. Presence maxima are monotone: a discarded losing
generation can never win after union with more entries. Thus both the winning G
and its witness selection are canonical functions of set union. Set union is
commutative, associative, and idempotent; inserting this canonical closure after
either parenthesization produces the same maxima and G witnesses. Canonical
ordering is only a representation function. Therefore logical merge is:

```text
compact(compact(A) ∪ B) = compact(A ∪ B)
```

Coordinate losers cannot beat retained maxima, and a losing generation cannot
become winning after union because its greater retained presence head cannot
disappear. A future winning add brings its own authority witnesses. Therefore:

```text
J1 ⊔ J2 = J2 ⊔ J1
(J1 ⊔ J2) ⊔ J3 = J1 ⊔ (J2 ⊔ J3)
J ⊔ J = J
```

These laws apply to logical journal merge, not to the complete graph merge.
They also exclude local indexes: changing an index affects no logical equality,
head, canonical event, value revision, generation, candidate, coherence, or graph
merge decision.

After accepting a peer journal, a writable host durably raises
`localJournalClock` to at least the greatest observed sequence before allocating
another entry. This watermark update and later allocations are serialized by
the journal-clock mutex. It does not alter imported entries.

## Virtual projections

For materialized semantic key `x`:

```text
valueHead(author,x,G) = greatest applicable value event by sequence
                        authored by author for generation G

valueEvents(x,G) = add G itself, plus edits for x whose generation == G

candidateEvents(x,G) = E such that
    E is in valueEvents(x,G) &&
    E.time == graph.timestamps[x].modifiedAt &&
    E == valueHead(E.author,x,G)

canonicalEvent(x,G) = greatest candidate by JournalEntryId
                      = greatest by (E.sequence,E.author)
origin(x,G) = canonicalEvent(x,G)
ValueRevision(x,G) = [modifiedAt(x), origin(x,G).author, origin(x,G).sequence]
```

Within this already equal-`modifiedAt` candidate set, sequence is primary
because it preserves observed-before order; author only breaks genuinely
concurrent equal-sequence ties. This does not make sequence the primary value
order across different wall times. If no candidate exists, the
materialization is provenance-obsolete/unusable; synchronization never invents
one.

When multiple current G-scoped value heads match one `modifiedAt`, the canonical
event is also an admissibility constraint, not merely a label inferred after value
selection. Each source candidate first resolves its alleged event in its own
reachable pre-merge snapshot. After journal join, only the candidate whose
alleged event equals `canonicalEvent(x,G)` may represent that timestamp. A lower
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
freshnessHead(x,G) = greatest invalidate/validate entry by JournalEntryId
                     whose generation == G
```

A delete head bars lower-ordered adds. Any greater add starts the winning
generation, whether causally later or concurrent with unrelated higher Lamport
history. For winning add G, only `freshnessHead(x,G)` has
freshness authority. Its invalidate bars older proofs for G; its validate
permits freshness only when current graph validity evidence is coherent. With no
entry scoped to G, the generation's initial graph freshness applies. An entry
scoped to an older or losing generation has no authority over G regardless of
its larger sequence or `JournalEntryId`.

These heads have explicit LWW total-order semantics. `JournalEntryId` does not
prove observation in the reverse direction: `E2.id > E1.id` does not imply E2
observed E1. Consequently a concurrent high-sequence add may cross an unseen
delete, and a concurrent high-sequence validate scoped to G may cross an unseen
invalidate for G. An entry authored after actually observing a barrier is still
guaranteed to sort later because the allocator raises its watermark first.

For source snapshot `S`, `sourceGenerationS(x)` is its pre-merge
`presenceHeadS(x)` when that head is an add. Once the joined `presenceHead(x)`
selects add generation G, only materializations with
`sourceGenerationS(x) == G` are admissible value candidates. A source whose
generation is an older or concurrent losing add cannot supply bytes for G.
`ValueRevision` orders candidates only within this surviving presence
generation. Thus concurrent adds cannot combine one add's presence frontier with
another add's value.

Edits scoped to any G1 other than winning G are inapplicable before timestamp
or author comparison. They cannot affect `valueHead(author,x,G)`,
`canonicalEvent(x,G)`, or `ValueRevision(x,G)`, even if they are the edit
notification-coordinate maximum or have a greater sequence, author, or wall
time.

Compaction preservation is proved in the compaction specification.

## Stable value identity invariant

In every reachable snapshot, two admissible materializations with equal
`ValueRevision` have equal `ComputedValue`:

* Base case: an atomic add establishes G; an atomic edit names its resolved G.
  Each commits exactly its value and real `modifiedAt`, and one author never
  reuses the sequence.
* Local step: before authoring a changed value event E2, the allocator watermark
  is at least every observed sequence. Therefore E2 has a greater sequence than
  every observed same-G event E1. If E1 and E2 share wall time, E2 is still the
  greatest matching `JournalEntryId` in the reachable post-transaction snapshot
  and remains canonical regardless of author lexical order. `Unchanged` retains
  both value and provenance.
* Copy step: synchronization copies an existing value and its unchanged origin
  entry. Exact timestamp collisions admit only the canonical event's source
  candidate, so selection cannot attach another candidate's bytes to that ID;
  equal revision retains equal bytes/value.
* Destructive step: delete removes the candidate and invalidate changes no
  value. Neither creates a counterexample.

Thus `ValueRevision` is collision-free over reachable admissible states. Its
lexicographic tuple is a strict deterministic total order: timestamps decide
first, different simultaneous authors second, repeated same-author changes at
one timestamp third. This external revision-tuple comparison is not provenance
recovery: matching same-time journal events were already reduced to one
canonical event by sequence-first `JournalEntryId`. Equal revision with unequal
values is corruption, not a hash tie-break case.

## Traces

* **Same writer/time:** A's edits at wall time 100 receive sequences 7 and 8;
  `[100,A,8]` wins.
* **Different wall times:** A edits at 10:00 with sequence 500; B edits at 10:01
  with sequence 20. B wins by the primary wall-time coordinate. Sequence 500 is
  irrelevant because canonical journal ordering is consulted only for an exact
  wall-time collision.
* **Concurrent writers/time:** A and B each edit at 100. Sequence chooses when
  `n != m`; author chooses only when `n == m`. No source-host tie-break is
  involved.
  If B is the canonical event but B's derived cache is unsupported against final
  inputs, coherent A is not mislabeled as B: the result is stale fallback for
  one input or deletion for multiple inputs.
* **Concurrent adds:** A adds K at `(10,A)` with `modifiedAt=200`; B adds K at
  `(50,B)` with `modifiedAt=100`. Joined presence chooses B's generation, so A's
  bytes are inadmissible despite their later wall time. The result uses B's
  value and derives `[100,B,50]`; presence and value cannot name different
  generations.
* **Concurrent old-generation validation:** A validates old G1 with
  `V=(100,A,generation=G1)`. Concurrently B establishes newer winning
  `G2=(20,B)` and invalidates it with
  `I=(21,B,generation=G2)`. C carries fresh/coherent G2 bytes. Although V has
  the greater entry ID, it is inapplicable to G2. `freshnessHead(K,G2)` is I, so
  C's incoming proofs are revoked and K remains stale until a later genuine
  validate scoped to G2.
* **Losing-generation edit collision:** G1 is old and G2 is the winning presence
  generation. A carries D on G1 and edit
  `E1=(author=A,time=T,generation=G1)`. B carries D on G2 with value event
  `E2=(author=B,time=T,generation=G2)`, and A sorts above B. Presence selects G2.
  E1 is inapplicable because its generation differs, so
  `canonicalEvent(D,G2)` considers only G2 events and E2 remains the correct
  provenance. The collision causes no conservative deletion.
* **Causally later equal-time edit:** A authors
  `E1=(sequence=10,author=A,generation=G,time=T)`. B synchronizes A, then
  genuinely changes the same materialization and authors
  `E2=(sequence=11,author=B,generation=G,time=T)`. Even if A sorts above B,
  `canonicalEvent(D,G)` selects E2 because sequence is primary within this
  equal-wall-time collision. If truly
  concurrent events instead have equal sequence, author deterministically
  breaks that tie.
* **Concurrent positive crossing:** A authors delete Q at sequence 40. Without
  observing Q, B has watermark 100 from unrelated history and authors add G at
  101. LWW presence selects G. Likewise, a greater concurrent validate scoped to
  G can supersede an unseen invalidate for G. This is total-order resolution,
  not evidence that B observed the destructive entry.
* **Carrier independence:** A's `[100,A,8]` travels A → B → C. B and C import
  the entry and allocate their own local indexes but author no edit. All three
  compare the same revision.
* **Same-writer supersession:** A's retained head is edit 12. A host carrying
  A's edit 8 cannot resolve it as a candidate, even if its timestamp is large;
  it cannot resurrect.
