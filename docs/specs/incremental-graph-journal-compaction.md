# Logical journal compaction

For notification coverage, entries retain the simple relation:

```text
E2 covers E1 iff
    E1.author == E2.author && E1.key == E2.key &&
    E1.action == E2.action && E2.sequence > E1.sequence
```

There is no cross-author coverage. Value and freshness authority add bounded
witness exceptions because an edit or freshness notification maximum may name a
losing presence generation.

## Canonical algorithm

For each key K, first compact add/delete coordinates and compute
`presenceHead(K)`. If that head is add G, G is the only presence generation that
can still win. Then retain:

1. the maximum entry for every `(author,K,action)` coordinate, preserving exact
   action-specific possible-change coverage and all presence heads;
2. for each author, the maximum edit for K whose explicit `generation == G`,
   when it differs from the edit notification maximum;
3. for each author and freshness action, the maximum entry in that coordinate
   whose explicit `generation == G`, when it differs from item 1; and
4. every add entry named as `generation` by an edit or freshness entry retained
   in items 1–3, as a generation-reference witness even when that add is covered
   for notification purposes.

If presence is absent, items 2 and 3 are empty. Edit/freshness entries whose
generation does not resolve to a validated same-key add are malformed and
rejected before compaction. Entries are returned in canonical `JournalEntryId`
order.

Thus the edit coordinate and each freshness coordinate retain at most their
notification head, one current-generation authority witness, and their
add-reference witnesses. The bound remains
`O(historic keys × writers)`—equivalently the existing
`O(historic keys × writers × 5)` with a fixed constant-factor increase—and is
not proportional to historical generations.

## Why a discarded generation cannot become relevant

Let G be the winning add when compaction runs. Every other retained add H has
`H.id < G.id`; every removed add is below a later same-author add and therefore
also cannot beat G. Future merge is set union plus maximum presence selection:
it cannot remove G. A later delete makes the key absent, and a later add creates
new generation G2; neither can make H win. Therefore a generation discarded as
losing can never again become the final presence generation in any future merge.
It is sound to discard its value and freshness authority while retaining the
coordinate notification heads.

If future add G2 wins, its own journal travels with edits and freshness entries
scoped to G2. Canonical compaction recomputes items 2 and 3 for G2 before
removing any witness. Consequently the value and freshness heads relevant to the
only generation that can win are never lost.

## Preservation proofs

* **Possible changes:** the coordinate maximum covers every older entry with the
  same author, key, and exact action. Receiver-local delivery records are
  self-contained, so a compacted optional `causeId` is never dereferenced.
* **Value head:** add G is retained, and item 2 retains every author's greatest
  edit scoped to G. These entries reconstruct exactly
  `valueHead(author,K,G)` even when an old-generation edit is the notification
  maximum. Losing-generation edits are inapplicable and can never regain
  authority because their add can never win later.
* **Presence head:** maxima for add/delete coordinates are retained, so their
  global maximum is unchanged. Extra covered add-reference witnesses are lower
  than those maxima and cannot change it.
* **Freshness head:** for winning G, item 3 retains each author's greatest
  invalidate and validate scoped to G. Taking the greatest ID across those
  witnesses gives exactly `freshnessHead(K,G)`. Entries for losing generations
  are inapplicable and never become applicable later.

Every synchronization projection and decision is therefore preserved. The
algorithm is a canonical closure: compacting twice changes nothing. Union is
commutative and associative, and discarded authority belongs only to generations
that cannot beat a retained presence head in any later union. Hence inserting
compaction after either parenthesization of journal union produces the same
notification maxima, winning generation, and value/freshness authority
witnesses; logical merge remains commutative, associative, and idempotent.

### Trace

For winning add G2, suppose A has `edit#110(generation=G1)`,
`edit#22(generation=G2)`, `validate#100(generation=G1)`, and
`invalidate#21(generation=G2)`. The old-generation entries remain coordinate
notification maxima, while edit 22 and invalidate 21 are retained as G2
authority witnesses. Thus neither `valueHead(A,K,G2)` nor
`freshnessHead(K,G2)` is displaced by larger G1 IDs. Once G2 wins, G1 can never
win later, so no other G1 authority history is required.
