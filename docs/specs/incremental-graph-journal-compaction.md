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
3. each author's greatest invalidate scoped to G, reconstructing `invalidateFrontier(K,G)`, and greatest validate scoped to G when different from coordinate maxima;
4. every exact invalidate referenced by every retained validation causal context, including coordinate-max validations for losing generations; and
5. every add referenced by a retained generation-scoped entry.

If presence is absent, generation-authority witnesses are empty. Invalid same-key generation references, unresolved/mismatched causal references, references not preceding their validation, and non-monotone same-author validation contexts reject the journal before selection. Reference closure leaves no dangling context. Results have canonical
`JournalEntryId` order.

Let G win before compaction. Every losing add H is below a retained presence
entry. Union cannot remove that entry; a greater delete makes K absent and a
greater add establishes new G2 while bringing its own witnesses. Thus H can
never regain authority in a future union. It is sound to discard H's value and
freshness authority while retaining coordinate maxima.

The algorithm preserves `presenceHead`; each winning-generation `valueHead(author,K,G)` by retaining add G and each author's greatest G-scoped edit; the exact equal-time `candidateEvents` inputs needed by `canonicalEvent(K,G)`; `invalidateFrontier(K,G)`; existence of an individual effective validation; every required generation reference; and every retained causal reference.

For same author/key/generation validations, journal validity requires later contexts to be componentwise nondecreasing. Thus an older discarded validation is dominated by the retained later one: every invalidate it covered remains covered. This is an enforced input invariant, not an assumption about well-behaved hosts.

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

A discarded coordinate loser cannot beat its retained maximum. Winning-generation value heads and equal-time canonical-event inputs remain explicit. A discarded older same-author invalidate is dominated by the retained frontier element. A discarded older same-author validation has a componentwise-dominated context by the validated monotonicity invariant. Every referenced invalidate and add remains resolvable. A delayed invalidate either adds an author coordinate or advances its frontier and defeats any validation that did not name it; this result is identical whether compaction ran before or after delivery. Partial validations never combine. Losing generations cannot regain authority, while a future greater add brings isolated value and freshness witnesses.

These cases establish closure under every later union. Since compaction is canonical and idempotent, closure plus ACI set union yields commutative, associative, and idempotent logical merge. The conclusion does not follow from union alone. Logical equality excludes local indexes.

## Fully compacted bound and optional timing

Let n be the number of current or historic semantic keys represented by the compacted journal/database, and r the number of durable authors represented by compacted entries or retained causal-context references. Finite schema arity and fixed maximum serialized `ConstValue` size make `NodeKey` constant-sized.

Per key, constant actions times r coordinates use `O(r)` entries. There are at most `O(r)` retained validations relevant to generation/coordinate structure, each carrying `O(r)` context; exact invalidate references contribute at most `O(r²)`. Other value, generation, freshness, and notification witnesses are no larger. Therefore `size(compact(J)) = O(nr²)`. One scalar `localIndex` per retained entry does not change the bound.

**This applies only to complete canonical compaction. No operation-count-independent bound is promised for an uncompacted journal.** Ordinary mutations may append without compacting. Compaction may run after any transaction, during maintenance or synchronization, repeatedly, at any time, or be skipped for arbitrarily many mutations. Correctness is timing-independent; a crash before optional compaction leaves valid uncompacted history. An independent compaction transaction atomically performs the witness touch described above.

## Executable bounded verification

`scripts/verify-journal-spec-model.py` uses one combined six-atom universe rather than a freshness-only universe. Its composite atoms preserve every materially distinct class while keeping full ACI exhaustive: competing generations and an intervening delete; losing coordinate maxima and winning edit witnesses; cross-author heads; two-author split invalidation knowledge; complete validation; a delayed later same-author hard invalidate; later complete validation; and generation replacement.

It checks 64 valid combined states and all 64 resulting compact states, 64 projection-preservation/idempotence checks, 4,096 full-universe closure pairs, and 262,144 full compact-universe ACI triples. Projections include presence/generation, value heads, equal-time canonical inputs, invalidate frontier, effective-validation existence, add references, and causal references. Negative cases reject malformed variants, observation-order violations, and backward same-author contexts.

The independent cursor model remains exhaustive and now covers 20,736
four-operation words and 82,944 committed prefixes, carrying 189,449
action-specific obligations through later prefixes. It covers unknown
installation, two keys, repeated touches, stale and partial-action cursors,
synchronization and migration stale→stale hardening, settled repetition without
endless barriers, combined graph transition plus compaction, settled no-op,
index uniqueness, and watermark coverage. A repeated same-key trace has 41 raw
records and two after canonical compaction. These finite structural checks
support, but do not prove, the analytical `O(nr²)` result.
