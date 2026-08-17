# Journal compaction

## Proof domain

This specification uses the
[journal supported-state boundary](incremental-graph-journal-types.md#supported-state-boundary),
which inherits the lifecycle definition in `database-lifecycle.md`. Every
preservation, dominance, freshness, closure, and merge claim below quantifies
over supported reachable journal states and deliveries/unions that are
supported protocol states, not arbitrary sets of fabricated entries.
Compaction need not preserve discarded evidence solely to diagnose a past or
future corrupted/unsupported history.

Compaction considers immutable `JournalEntry` contents only. Notification records, indexes, watermarks, and coverage are a separate layer and do not participate in logical selection.

## Canonical algorithm

For each key K, compact add/delete coordinates and compute `presenceHead(K)`. If
it is add G, retain:

1. the maximum entry for every `(author,K,action)` coordinate;
2. each author's greatest edit scoped to G when different from its coordinate
   maximum;
3. each author's greatest invalidate scoped to G, reconstructing `invalidateFrontier(K,G)`, and greatest validate scoped to G when different from coordinate maxima;
4. every exact invalidate referenced by every retained validation causal context, including coordinate-max validations for losing generations; and
5. every add referenced by a retained generation-scoped entry.

If presence is absent, generation-authority witnesses are empty. Retained
generation and causal references must be structurally resolvable and meaningful
before selection. Implementations MAY also reject non-monotone contexts and
other corruption defensively when evidence is available, but compaction
correctness does not require complete diagnosis of unsupported history.
Reference closure leaves no dangling retained context. Results have canonical
`JournalEntryId` order.

Let G win before compaction. Every losing add H is below a retained presence
entry. Union cannot remove that entry; a greater delete makes K absent and a
greater add establishes new G2 while bringing its own witnesses. Thus H can
never regain authority in a future union. It is sound to discard H's value and
freshness authority while retaining coordinate maxima.

The algorithm preserves `presenceHead`; each winning-generation `valueHead(author,K,G)` by retaining add G and each author's greatest G-scoped edit; the exact equal-`time` `candidateEvents` inputs needed by `canonicalEvent(K,G)`; `invalidateFrontier(K,G)`; existence of an individual effective validation; every required generation reference; and every retained causal reference.

For same author/key/generation validations, supported authoring makes later
contexts componentwise nondecreasing. Thus an older discarded validation is
dominated by the retained later one: every invalidate it covered remains
covered. This is a reachable-state invariant guaranteed by a correct durable
author, not a claim about arbitrary structurally constructible entries.

## ACI closure proof

For supported reachable journal states A and B whose delivery/union is a
supported protocol state, canonical compaction satisfies:

```text
compact(compact(A) union B) = compact(A union B)
```

A discarded coordinate loser cannot beat its retained maximum. Winning-generation value heads and equal-time canonical-event inputs remain explicit. A discarded older same-author invalidate is dominated by the retained frontier element. A discarded older same-author validation has a componentwise-dominated context by the supported-authoring monotonicity invariant. Every referenced invalidate and add remains resolvable. A delayed supported invalidate either adds an author coordinate or advances its frontier and defeats any validation that did not name it; this result is identical whether compaction ran before or after delivery. Partial validations never combine. Losing generations cannot regain authority, while a future greater add brings isolated value and freshness witnesses. Delayed delivery of another supported history cannot expose a same-author regression because no supported durable author can create one.

These cases establish closure under every later supported union. Since
compaction is canonical and idempotent on this domain, closure plus ACI set union
yields commutative, associative, and idempotent logical merge for supported
histories. These are not algebraic claims over arbitrary sets of
`JournalEntry` values. The conclusion does not follow from union alone. Logical equality excludes the complete notification layer.

## Notification compaction

Notification compaction is separate:

```text
compactNotifications(N) =
    for each semantic NodeKey, retain its greatest-index JournalRecord
```

It is pure deletion: `compactNotifications(N) subset-of N`. It creates or
changes no record, index, logical entry, cursor, allocator, high-watermark,
coverage coordinate. It may run independently,
during synchronization or maintenance, repeatedly, or never. Uncompacted
records may grow with operation count.

For each deleted same-key R the retained W satisfies `W.index > R.index` and
projects all five actions. Thus max-per-key compaction is canonical and:

```text
compactN(compactN(A) union B) == compactN(A union B)
```

Union plus compaction is commutative, associative, and idempotent. Resent old
occurrences cannot resurrect in canonical compact state.

## Deletion transparency and notification safety

Let `results(N,C,F)` be the ordered query sequence. For every valid cursor and
filter, if `N' = compactNotifications(N)`:

```text
results(N', C, F) =
    the subsequence of results(N, C, F)
    whose underlying JournalRecord survives in N'
```

No survivor changes position or crosses a cursor cut; no cursor is rebased; a
cursor naming a deleted record remains valid. Compaction may remove future work
but never claims consumer progress.

If deleted R covered an action obligation, retained same-key W has `C < R < W`
for every cursor not past R and expands to all actions. Notification compaction
therefore introduces no action-specific false negative. W's witness time may
replace the precise transition time because this API is conservative.

## Combined compacted storage theorem

For the combined durable journal state define:

```text
n = number of current or historic semantic keys represented by either the
    compacted logical journal or compacted notification journal
r = number of durable fingerprints represented by compacted logical entries,
    retained causal references, or cursorCoverageFrontier
```

The existing fixed C, K, and d assumptions and bounded fingerprint contract
remain as defined in the types specification. Broadening n and r cannot weaken
the logical bound proved below: compact logical history is still `O(nr²)`. Fully compacted notifications retain at most one record per represented key.
Each record's semantic address is bounded under fixed finite schema arity,
bounded schema node names, fixed C for every binding `ConstValue`, and fixed K
for its redundant identity-preserving `NodeKey`; therefore notifications are
`O(n)`. Coverage metadata retains at most one bounded coordinate per represented fingerprint, `O(r)`; allocators and the high-watermark are constant-size. Thus, for `n > 0` and `r >= 1`, total compacted
journal and cursor metadata remain `O(nr²)`. Application-owned persisted tokens
are not journal storage. No operation-count-independent bound applies to either
uncompacted history.

## Optional timing and executable evidence

Logical and notification compaction may run after any transaction, during
maintenance or synchronization, repeatedly, or be skipped. Correctness is
timing-independent and a crash before optional compaction leaves valid
uncompacted state. Notification compaction performs no covering append.

The executable model exhausts the retained logical supported-state universe and
the bounded notification semilattice, and additionally exhausts bounded words of
notification transitions while carrying action-specific obligations. These
finite checks support, but do not replace, the analytical future-union, storage,
and cursor proofs.
