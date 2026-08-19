# IncrementalGraph journal compaction

For supported J, canonical seeds are exactly:

```text
N  = greatest E per (author,key,publicAction)             # polling, all actions non-null
P  = causal presenceHead per key, plus reset-bridge anchor presence
VH = winning-generation valueHead per author
CE = exact equal-time candidate value heads
IF = complete applicable invalidateFrontier for every retained winning-generation value origin
HF = complete applicable hardInvalidateFrontier for every retained winning-generation value origin
VV = greatest validation per (author,key,winning generation,retained value origin)
RL = greatest reset-lineage summary per (key,receiver anchor)
```

Start with `N∪P∪VH∪CE∪IF∪HF∪VV∪RL`; take the least closure adding each retained scoped event's exact GenerationJournalEntry, every retained value-specific assertion's exact value-origin event, and every retained generation's mandatory initial-freshness event. `compact(J)` is exactly this closure and discards everything else. `HF` may overlap `IF`: all-mode per-author maxima can be later soft invalidates while older hard per-author maxima remain causal must-recompute authority. Value-specific barriers for losing retained heads remain polling/candidate evidence but do not enter another origin's applicable frontier.

Frontiers are retained as whole sets, never reduced member-by-member against different validations. Thus `freshnessEffective` and `hardnessCleared` continue to require one actual validation covering the complete applicable frontier; compaction cannot combine partial validations. A delayed non-frontier invalidate under retained `clearsThrough` remains causally cleared, while an event above the prefix can become a new frontier member. Public maxima preserve action no-false-negatives.

**Canonical Compaction/Future-Union Theorem.** On supported reachable histories, full frontier retention preserves freshness and hardness exactly, including histories where different validations cover different hard members. Causal-prefix dominance is stable under delayed events below the prefix, while events above it enter IF/HF. Value/presence heads are monotone. Validation knowledge is componentwise monotone per author/key/generation because every later validation carries forward its greatest prior vector; therefore VV dominates discarded older validations semantically. Therefore:

```text
compact(compact(A) union B) = compact(A union B)
```

Merge is ACI and physical survivors are uniquely determined. Generation initial freshness, reset validations, polling maxima, equal-time provenance, and delayed covered invalidates obey the same equality. RL selection runs independently of whether causal presence is present or absent. It retains the reset summary, its exact receiver generation/value anchor or reset delete anchor, and active post-cutoff source generation/value/presence witnesses. A later same-anchor summary subsumes an earlier one only under componentwise vector carry-forward. Consequently a post-cutoff delete may be the causal presence head without discarding the bridge needed by a later rematerialization, and compaction cannot erase the distinction between absorbed and live history.

For n semantic keys and r durable authors, polling/value evidence is O(nr); applicable frontiers across O(nr) retained value heads and reset-lineage vector coordinates are O(nr²); validation vectors/heads are O(nr²); coverage is O(r). Total remains globally `O(nr²+r)`, reducing to O(nr²) for n>0,r>=1; n=0 may retain O(r) vector metadata with empty journal.
