# Logical journal synchronization

## Merge

Only immutable logical entries replicate. Receiver-local `localIndex` values,
`localJournalIndexWatermark`, and harmless gaps do not.

```text
J1 ⊔ J2 = compact(entries(J1) ∪ entries(J2))
```

Inputs must have the same schema, valid durable authors, valid actions and keys,
and unique content for every `JournalEntryId`. Every edit/invalidate/validate must carry a generation resolving to a valid same-key add in the validated merge input. Every validation context coordinate `A -> I` must resolve I in that input; I must be a same-key, same-generation invalidate authored by A, and `I.sequence < V.sequence`. For every two validations V1,V2 with the same author, key, and generation and `V1.sequence < V2.sequence`, V2 must contain an equal-or-later same-author invalidate reference for every coordinate in V1. It may add or advance coordinates, but never forget or move one backward. Journals violating either causal-reference rule are rejected atomically before merge or compaction. Two entries
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
invalidateFrontier(x,G)[A] = greatest invalidate authored by A whose generation == G
covers(V,I) iff V.key == I.key && V.generation == I.generation &&
    V.clearsInvalidates[I.author] names I or a later same-author invalidate
effectiveValidate(V,x,G) iff V is scoped to x,G and
    V individually covers every element of invalidateFrontier(x,G)
```

A delete head bars lower-ordered adds. Any greater add starts the winning generation, whether causally later or concurrent with unrelated higher Lamport history. For winning add G, each author's frontier invalidate is an independent barrier. One applicable validation permits journal freshness only when it individually covers the entire joined frontier; several partial validations MUST NOT be combined. With no invalidates scoped to G, the generation's initial graph freshness applies. An effective validation still cannot manufacture graph validity: current graph validity evidence must be coherent. Entries from losing generations have no authority over G.

`JournalEntryId` ordering alone never proves observation. In particular, a high-sequence validation cannot clear a lower-ID invalidate absent an exact-or-later reference in its immutable context. A delayed invalidate therefore immediately makes a previous validation insufficient. A genuine normal revalidation captures the complete transaction-visible frontier atomically and can restore journal freshness after observing all barriers.
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
  with sequence 20. B's `ValueRevision` ranks higher among the candidates being
  compared at that selection stage because wall time is its primary coordinate.
  Sequence 500 is irrelevant because canonical journal ordering is consulted
  only for an exact wall-time collision. For a derived node,
  coherence/admissibility may exclude B before that comparison; this trace does
  not make a newer unsupported candidate win.
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
  `I=(21,B,generation=G2)`. C carries fresh/coherent G2 bytes. Although V has the greater entry ID, it is inapplicable to G2. No validation scoped to G2 covers I, so C's incoming proofs are revoked until a later genuine validation for G2 names I.
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
  101. LWW presence selects G. Freshness differs: a concurrent validation cannot
  clear an unseen invalidate regardless of its ID because its causal context
  does not name that barrier.
* **Carrier independence:** A's `[100,A,8]` travels A → B → C. B and C import
  the entry and allocate their own local indexes but author no edit. All three
  compare the same revision.
* **Same-writer supersession:** A's retained head is edit 12. A host carrying
  A's edit 8 cannot resolve it as a candidate, even if its timestamp is large;
  it cannot resurrect.

## Causal freshness traces

* **High-clock old validation:** `V=(101,B,G)` with an empty context does not cover delayed `I=(10,A,G)`; K is stale.
* **Observed and split invalidations:** a genuine validation naming I may clear it subject to graph coherence. If `I_A` and `I_C` exist, validations separately naming one each do not combine; one later validation naming both is required.
* **Later same-author invalidate:** a validation naming `I_A1` does not cover later `I_A2`; a later validation may name I_A2 and thereby also cover I_A1.
* **Already-stale explicit invalidation:** A's propagated I0 leaves K stale with incoming proofs. B observes I0, revalidates, and authors V0 naming I0. A has not observed V0; its later explicit `invalidate(K)` removes incoming proofs and authors new generation-scoped I1 even though freshness stays stale. On merge, V0 does not name I1, so I1 remains outstanding and recomputation is mandatory. Repeating explicit hard invalidation repeats proof removal and authors a fresh causal barrier each time.
