# Journal synchronization

Logical synchronization is `compact(entries(J1) union entries(J2))`. Entry identity is immutable `JournalEntryId=(sequence,author)`; receiver-local indexes do not participate. Import rejects conflicting identity, invalid generation references, and every validate context whose referenced entry is absent or is not a same-key, same-generation invalidate by the mapped author.

For winning add generation G, derive `invalidateFrontier(K,G)` independently per author. A validate V covers I only if its context for I.author names I or a later same-author invalidate in the same K,G stream. V is effective only if V alone covers the complete frontier. Validations are never combined, ID order is not causal evidence, and synchronization never synthesizes validate. An effective validation merely removes the journal barrier; ordinary graph coherence is still required.

Thus an unseen delayed invalidate immediately defeats an older validation, split partial validations cannot invent a complete recomputation, a genuine later revalidation after observing the full frontier can clear it, and old-generation facts cannot affect a new winning add.

Canonical compaction retains notification coordinate maxima, winning-generation value witnesses, each author's greatest invalidate and validate, every causal invalidate referenced by any retained validation (including losing-generation coordinate maxima), and every referenced add. Same-author later validation contexts are componentwise monotone. Consequently a discarded fact is either coordinate-dominated, same-author causally dominated, or belongs to a permanently losing generation. A delayed union has the same frontier and effective-validation result before or after compaction:

```text
compact(compact(A) union B) = compact(A union B)
```

This closure, canonical idempotence, and set-union ACI prove logical merge commutative, associative, and idempotent, including delayed hosts and future greater adds. Independent compaction atomically touches a retained same-key notification witness when removing history.

The storage guarantee is only `size(compact(J)) = O(nr²)`. An uncompacted journal may grow with operation count, and compaction may run at any time or be skipped arbitrarily long without affecting correctness.
