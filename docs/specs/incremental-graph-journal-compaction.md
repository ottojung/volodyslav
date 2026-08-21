# IncrementalGraph journal compaction

For supported J, canonical seeds are exactly:

```text
N  = greatest E per (author,key,publicAction)             # polling, all actions non-null
P  = causal presenceHead per key, plus reset-bridge anchor presence
VH = winning-generation valueHead per author
CE = exact equal-time candidate value heads
IF = complete applicable invalidateFrontier for every retained winning-generation value origin
HF = complete applicable hardInvalidateFrontier for every retained winning-generation value origin
VV = greatest validation per (author,key,winning generation,retained value origin),
     considering only targets in retained VH/CE value origins
RLV = canonical coordinate witness for each applicable (key,receiverAnchor,observedAuthor)
RLC = canonical carrier for each exact (key,retained receiver value anchor,source generation,source origin)
```

Start with `N∪P∪VH∪CE∪IF∪HF∪VV∪RLV∪RLC`; take the least closure adding each retained scoped event's exact GenerationJournalEntry, every retained value-specific assertion's exact value-origin event, and every retained generation's mandatory initial-freshness event. `compact(J)` is exactly this closure and discards everything else. `HF` may overlap `IF`: all-mode per-author maxima can be later soft invalidates while older hard per-author maxima remain causal must-recompute authority. Value-specific barriers for losing retained heads remain polling/candidate evidence but do not enter another origin's applicable frontier.

Frontiers are retained as whole sets, never reduced member-by-member against different validations. Thus `freshnessEffective` and `hardnessCleared` continue to require one actual validation covering the complete applicable frontier; compaction cannot combine partial validations. A delayed non-frontier invalidate under retained `clearsThrough` remains causally cleared, while an event above the prefix can become a new frontier member. Public maxima preserve action no-false-negatives.

**Canonical Compaction/Future-Union Theorem.** On supported reachable histories, full frontier retention preserves freshness and hardness exactly, including histories where different validations cover different hard members. Causal-prefix dominance is stable under delayed events below the prefix, while events above it enter IF/HF. Value/presence heads are monotone. Validation knowledge is componentwise monotone per author/key/generation because every later validation carries forward its greatest prior vector; therefore VV dominates discarded older validations semantically. Therefore:

```text
compact(compact(A) union B) = compact(A union B)
```

Merge is ACI and physical survivors are uniquely determined. Generation initial freshness, reset validations, polling maxima, equal-time provenance, and delayed covered invalidates obey the same equality. Reset observation selection runs independently of raw presence order and first evaluates each anchor against its own joined vector. `receiverAnchor` is the tagged identity `null-absence`, `(delete,DeleteJournalEntry.id)`, or `(present,valueOrigin)`; tags prevent equal vector coordinates on different anchor domains from dominating one another. For every `(receiverAnchor,observedAuthor)` coordinate among applicable lineages, RLV retains the carrier with greatest coordinate, breaking equal-coordinate ties by full JournalEntryId; vectors join componentwise only within that anchor. In particular a present or delete carrier never replaces a null-anchor witness needed by a future raw-head change. RLC uses a separate relevance predicate: when causal `presenceHead` is generation G, every exact carrier whose receiver value origin is a retained `valueHead(J,K,G,A)` is retained, even if that carrier is not RLV-applicable. RLC therefore preserves exact unsupported-cache evidence for a generation activated across a delete/null lineage. It retains each exact `(key,receiverValueOrigin,sourceGeneration,sourceValueOrigin)` relation with deterministic full-ID tie-breaking. VV is independently restricted to those same retained value origins; historical-origin validations survive only through another seed such as public N, mandatory initial freshness, or RLC. Internal absent observations, receiver anchors, and active post-cutoff witnesses also survive their respective seeds. Thus concurrent vectors join without false sequence causality, two receiver origins certified against one source pair remain distinct, ordinary edit count does not expand VV, exact equality evidence is not widened to a prefix, and absent compaction preserves future rematerialization.

For n semantic keys, r durable authors, and c distinct full `(key,receiverValueOrigin,sourceGeneration,sourceValueOrigin)` semantic reset correspondences that must remain recognizable to lagging replicas, polling/value evidence is O(nr); frontiers, lineage coordinate witnesses, and validation vectors are O(nr²). Every exact-correspondence carrier physically contains its causal-prefix vector, so those carriers and their coordinates use O(cr), not O(c); coverage is O(r). Total is `O(nr²+cr+r)`, reducing to O(nr²+cr) for n>0,r>=1. The cr term is necessary: repeated equal reset against distinct rematerialization origins creates Ω(c) exact membership facts, and a source containing r durable authors makes each retained carrier Θ(r). A causal prefix cannot certify unrelated origins, and discarding exact pairs breaks lagging certified peers. n=0 with no represented historical key or correspondence has empty journal and O(r) coverage.
