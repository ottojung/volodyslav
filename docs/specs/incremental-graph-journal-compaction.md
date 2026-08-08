# Logical journal compaction

For notification coverage, entries retain the simple relation:

```text
E2 covers E1 iff
    E1.author == E2.author && E1.key == E2.key &&
    E1.action == E2.action && E2.sequence > E1.sequence
```

There is no cross-author coverage. Freshness authority adds one bounded witness
exception because the greatest notification entry may name a losing presence
generation.

## Canonical algorithm

For each key K, first compact add/delete coordinates and compute
`presenceHead(K)`. If that head is add G, G is the only presence generation that
can still win. Then retain:

1. the maximum entry for every `(author,K,action)` coordinate, preserving exact
   action-specific possible-change coverage and all value/presence heads; and
2. for each author and freshness action, the maximum entry in that coordinate
   whose explicit `generation == G`, when it differs from item 1.
3. every add entry named as `generation` by a freshness entry retained in items
   1 or 2, as a generation-reference witness even when that add is covered for
   notification purposes.

If presence is absent, item 2 is empty. Freshness entries whose generation does
not resolve to a validated add are malformed and rejected before compaction.
Entries are returned in canonical `JournalEntryId` order.

Thus a freshness coordinate retains at most its notification head, one
current-generation authority witness, and their add-reference witnesses. The
bound remains `O(historic keys × writers × 5)` with a fixed constant factor;
it is not proportional to historical generations.

## Why a discarded generation cannot become relevant

Let G be the winning add when compaction runs. Every other retained add H has
`H.id < G.id`; every removed add is below a later same-author add and therefore
also cannot beat G. Future merge is set union plus maximum presence selection:
it cannot remove G. A later delete makes the key absent, and a later add creates
a new generation G2; neither can make H win. Therefore a generation discarded
as losing can never again become the final presence generation in any future
merge. It is sound to discard its freshness authority while retaining the
coordinate notification head.

If a future add G2 wins, its own journal travels with freshness entries scoped
to G2. Canonical compaction recomputes item 2 for G2 before discarding any
witness. Consequently the freshness event relevant to the only generation that
can win is never lost.

## Preservation proofs

* **Possible changes:** the coordinate maximum covers every older entry with the
  same author, key, and exact action. Receiver-local delivery records are
  self-contained, so a compacted optional `causeId` is never dereferenced.
* **Value head:** maxima for add/edit coordinates are retained; replacing a
  coordinate maximum can only advance it.
* **Presence head:** maxima for add/delete coordinates are retained, so their
  global maximum is unchanged. Extra covered add-reference witnesses are lower
  than those maxima and cannot change it.
* **Freshness head:** for winning G, item 2 retains each author's greatest
  invalidate and validate scoped to G. Taking the greatest ID across those
  witnesses gives exactly `freshnessHead(K,G)`. Entries for losing generations
  are inapplicable by definition and, by the argument above, never become
  applicable later.

Every synchronization projection and decision is therefore preserved. The
algorithm is a canonical closure: compacting twice changes nothing. Union is
commutative and associative, and discarded authority belongs only to generations
that cannot beat a retained presence head in any later union. Hence inserting
compaction after either parenthesization of journal union produces the same
notification maxima, winning generation, and authority witnesses; logical merge
remains commutative, associative, and idempotent.

### Trace

For winning add G2, suppose A has `validate#100(generation=G1)` and
`invalidate#21(generation=G2)`. If both share an author/action coordinate in a
larger trace, the overall maximum is retained for notification coverage and the
greatest G2-scoped entry is additionally retained as its authority witness.
`freshnessHead(K,G2)` therefore cannot be displaced or erased by the larger
old-generation ID. Once G2 wins, G1 can never win later, so no G1 authority
history beyond the notification maximum is required.
