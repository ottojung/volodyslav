# IncrementalGraph journal compaction

For supported J, canonical seeds are exactly:

```text
N  = greatest E per (author,key,publicAction)             # polling, all actions non-null
P  = presenceHead per key
VH = winning-generation valueHead per author
CE = exact equal-time candidate value heads
UF = all-mode frontier members not covered by any one retained applicable validation
UH = hard-frontier members not covered by any one retained applicable validation
VV = greatest validation per (author,key,winning generation)
```

Start with `N∪P∪VH∪CE∪UF∪UH∪VV`; take the least closure adding each retained scoped event's exact GenerationJournalEntry and every retained generation's mandatory initial-freshness event. `compact(J)` is exactly this closure and discards everything else. Causal-prefix validations need no exact invalidate references. Their legitimacy survives deletion because the closed-prefix proof is the immutable vector plus durable lifecycle validity, distinct from host coverage.

A delayed invalidate under retained `clearsThrough` remains causally cleared, although N retains it if needed as a polling representative. An event above the prefix remains unresolved. Public maxima, not hidden state, preserve action no-false-negatives.

**Canonical Compaction/Future-Union Theorem.** On supported reachable histories, causal-prefix dominance is stable under delayed events below the prefix, while events above it enter UF/UH. Value/presence heads and validation knowledge are monotone. Therefore:

```text
compact(compact(A) union B) = compact(A union B)
```

Merge is ACI and physical survivors are uniquely determined. Generation initial freshness, reset validations, polling maxima, equal-time provenance, and delayed covered invalidates obey the same equality.

For n semantic keys and r durable authors, polling/value/frontier evidence is O(nr); validation vectors/heads are O(nr²); coverage is O(r). Total is globally `O(nr²+r)`, reducing to O(nr²) for n>0,r>=1; n=0 may retain O(r) vector metadata with empty journal.
