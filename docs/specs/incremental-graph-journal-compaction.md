# IncrementalGraph journal compaction

Canonical compaction retains these seeds:

```text
N  greatest local sequence per (author,key,publicAction), excluding no-action events
P  every causal-maximal eligible presence event and reset-bridge anchor presence
VH same-author value head per author for each retained generation
ET causal maxima needed for exact-time canonical provenance
IF complete applicable all-mode invalidate frontier for each retained value origin
HF complete applicable hard frontier for each retained value origin
VV greatest validation per (author,key,generation,retained value origin)
RL maximal reset fallback assertion antichain and its anchor witnesses
RC every exact retained reset correspondence
```

It then takes the least closure containing each scoped event's generation, each value-specific assertion's origin, every generation's initial freshness event, and event identities/contexts needed to validate retained references. `compact(J)` is exactly that closure. Presence and equal-time seeds are sets of causal maxima. Concurrent maxima are retained even when the current deterministic conflict winner is one member, because a future event may causally dominate only part of the antichain.

Frontiers remain whole sets; compaction cannot combine partial validations. `HF` may contain an older same-author hard member when the all-mode head is soft. Value-specific barriers for losing heads remain only when required by polling, candidate provenance, or future union and never stale another origin.

Reset fallback assertions form a causal-maximal antichain across all anchors, including currently inapplicable anchors that can regain relevance after delayed union. Same-author order comes from local sequence; cross-author succession comes from immutable context. Concurrent assertions use occurrence time then fingerprint for the current fallback, but all causal maxima remain retained. `absorbsThrough` preserves absorption and does not prove assertion order. Exact correspondence retention is independent and never widened into prefix evidence.

## Future-union theorem

Every locally authored event carries forward all observed cross-author causal coordinates. `causalSummary` retains the componentwise observation closure even if the witnessed events are compacted. Consequently a discarded event's causal meaning survives in every retained descendant that depends on it, and a later locally authored event cannot forget it. If no retained descendant depends on a discarded event, future union can only reintroduce it as an event already dominated by retained context or as a semantically irrelevant non-frontier/non-head event.

Per-author heads and frontiers are monotone under future union. Immutable contexts keep causal domination stable; a future event can dominate some current maxima but cannot make a discarded dominated event maximal without also confronting its retained dominator. Validation vectors monotonically carry same-author/key/generation clearing evidence. Reset antichains retain every undominated assertion and exact correspondence. Polling retains per-author maxima. Therefore, for supported histories:

```text
compact(compact(A) union B) = compact(A union B)
```

The equality covers causal presence/value traces, delayed history, freshness, reset fallback, correspondences, and public polling. Merge is associative, commutative, and idempotent.

## Bound

Let n be represented semantic keys, r durable authors, and c distinct exact reset correspondences required by lagging replicas. Per-author polling/value/presence evidence and reset assertions contribute `O(nr)` events. Each event has an `O(r)` causal context; frontiers, validations, reset absorption vectors, and closure witnesses likewise contribute `O(nr²)` coordinate slots. Exact correspondences contribute c carriers with `O(r)` context/absorption coordinates, or `O(cr)`. Same-author heads and causal domination bound repeated authorities; concurrent cross-author antichains have at most the represented r writers per semantic role. Coverage and causal summary are `O(r)` and are absorbed by the bound for positive n and r.

Thus compacted journal, coverage, and causal metadata contain `O(nr² + cr)` logical records and coordinates. If b is the maximum byte length of any retained arbitrary-precision coordinate, serialized storage is `O(b(nr² + cr))`. This is an accounting result, not a runtime cap.
