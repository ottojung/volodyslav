# Logical journal compaction

Compaction considers immutable `JournalEntry` contents only; `localIndex` is
ignored. For notification coverage, E2 covers E1 when author, key, and action are
equal and E2 has greater sequence. There is no cross-author coverage.

## Canonical algorithm

For each key K, compact add/delete coordinates and compute `presenceHead(K)`. If
it is add G, retain:

1. the maximum entry for every `(author,K,action)` coordinate;
2. each author's greatest edit scoped to G when different from its coordinate
   maximum;
3. each author's greatest invalidate and validate scoped to G when different
   from their coordinate maxima; and
4. every add referenced by a retained generation-scoped entry.

If presence is absent, generation-authority witnesses are empty. Invalid
same-key generation references reject the journal. Results have canonical
`JournalEntryId` order.

Let G win before compaction. Every losing add H is below a retained presence
entry. Union cannot remove that entry; a greater delete makes K absent and a
greater add establishes new G2 while bringing its own witnesses. Thus H can
never regain authority in a future union. It is sound to discard H's value and
freshness authority while retaining coordinate maxima.

The algorithm preserves `presenceHead`, every `valueHead(author,K,G)`,
`canonicalEvent(K,G)` inputs, `freshnessHead(K,G)`, and all add references. It
retains a constant number per author/key/action plus constant witnesses, hence
`O(nr)` entries, where n is the number of current or historic semantic keys and
r is the number of distinct durable authors represented by retained history.
The five actions contribute only a constant factor.

## Cursor coverage when entries are removed

For every K from which compaction removes entries, choose the greatest retained
`notificationWitness(K)` and touch it once after logical compaction. Touching
updates only its local index. It is not part of canonical selection.

Let C precede an occurrence represented by removed E. Witness W receives index w
above the transaction's previous watermark, so `C < w`; a later query sees W.
W expands to all five actions and covers every action E could expose. A cursor at
or beyond w has already crossed that covering possibility. Compaction therefore
cannot create a false negative. Trace: removing old same-key entries touches one
surviving witness; no logical duplicate is appended.

## ACI closure proof

Canonical compaction satisfies:

```text
compact(compact(A) union B) = compact(A union B)
```

A discarded coordinate loser cannot beat its retained greater coordinate entry.
A discarded losing generation cannot win later by the monotonic-presence
argument above. A future greater add brings its retained generation witnesses.
Therefore early compaction loses no fact that a future union can select.

Since set union is ACI and compaction is canonical and idempotent:

```text
A join B = B join A
(A join B) join C = A join (B join C)
A join A = A
```
Logical equality and this proof exclude local indexes entirely.

## Continuous bound

Each retained entry stores exactly one scalar local index. Touches change that
integer, never record count. Canonical entries and any reconstructible index are
both `O(nr)` continuously, independent of touch count, synchronization count,
and database age. The finite schema bounds binding arity and maximum serialized
`ConstValue` size is a fixed system constant, so `NodeKey` size contributes only
a constant factor. The journal has no closed writer-membership domain; new
supported hosts may increase r, and no bound independent of r is guaranteed.

## Executable bounded verification

`scripts/verify-journal-spec-model.py` exhaustively checks 128 valid states and
96 distinct compact states in a two-author universe. Its deliberately chosen
ordering classes include concurrent cross-author adds, same-author successive
adds, an intervening delete, cross-author value/freshness heads, generation
references, and both directions of coordinate-maximum versus winning-generation
witness ordering. In particular, losing-generation edit, invalidate, and
validate coordinate maxima at sequences 110, 111, and 112 coexist with required
winning-generation witnesses at sequences 22, 23, and 24; compaction must
retain both sides of every pair.

The verifier checks idempotence and every synchronization projection on all 128
states, all 16,384 valid closure pairs, and all 884,736 compact-state merge
triples for ACI. Logical comparison excludes local indexes.

Its cursor model exhausts 10,000 four-operation words and checks all 40,000
committed prefixes immediately, including unknown installation, authored
entries, two keys, repeated touches, combined graph transition and compaction,
stale and partial-action cursors, and settled no-op. It performs 97,151
action-specific obligation checks. At most three logical records exist in that
universe despite arbitrary touches. These finite checks cover logical compaction
projections, generation-reference validity, ACI, cursor coverage, touch
behavior, and bounded record count in this fixed two-author universe. They
support but do not replace the normative proofs and do not test historical
computation provenance, graph coherence, or a bound independent of author count.
