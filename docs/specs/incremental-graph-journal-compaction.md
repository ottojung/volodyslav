# Journal compaction

Logical journal compaction remains the canonical generation-, frontier-, and
causal-context algorithm. It is defined only on immutable `JournalEntry`
contents, preserves all logical projections under every future union, and keeps
logical merge commutative, associative and idempotent. Its existing fixed-K
bound remains `O(nr²)`.

## Notification compaction

Notification compaction is separate:

```text
compactNotifications(N) =
    for each semantic NodeKey, retain its greatest-index JournalRecord
```

It is pure deletion: `compactNotifications(N) subset-of N`. It creates or
changes no record, index, logical entry, cursor, clock, high-watermark, or
coverage coordinate. It may run independently, during synchronization or
maintenance, repeatedly, or never; correctness does not depend on timing.
Uncompacted records may grow with operation count.

For each deleted same-key R the retained W satisfies `W.index > R.index` and
projects all five actions. The resulting max-per-key semilattice has:

```text
compactN(compactN(A) union B) == compactN(A union B)
```

and union-plus-compaction is commutative, associative and idempotent. Resent old
occurrences cannot resurrect in canonical compact state.

## Deletion transparency

Let `results(N,C,F)` be the ordered query sequence. For every valid cursor and
filter, if `N' = compactNotifications(N)`:

```text
results(N', C, F) =
    the subsequence of results(N, C, F)
    whose underlying JournalRecord survives in N'
```

No survivor changes position or crosses a cursor cut; no cursor is rebased; a
cursor naming a deleted record remains valid. Compaction may remove future work
but never claims consumer progress. This is the central cursor-compaction law.

For an action obligation covered by deleted R, retained same-key W has
`C < R < W` for every cursor not yet past R and expands to all actions. Thus
notification compaction introduces no action-specific false negative, although
W's witness time may replace the precise transition time.

## Storage theorem

Under the existing fixed-K assumptions, logical compacted history is `O(nr²)`.
Fully compacted notifications retain at most one bounded-scalar-plus-NodeKey
record per historic/current semantic key, `O(n)`. Coverage has at most one
scalar coordinate per represented durable fingerprint, `O(r)`, and allocator
and high-watermark metadata are constant size. For `r >= 1`, complete compacted
journal and cursor metadata remain `O(nr²)`. Persisted application/computor
tokens are not journal storage. No operation-count-independent bound applies to
uncompacted notification or logical history.
