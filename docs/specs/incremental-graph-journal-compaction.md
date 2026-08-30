# IncrementalGraph journal compaction

Canonical compaction retains these seeds:

```text
N  greatest local sequence per (author,key,publicAction), excluding no-action events
P  each RL survivor's per-anchor result presence and its selecting authority;
   ordinary causal-maximal presence when RL is empty
AC one non-assertion ResetAnchorCutSummary per tagged anchor whose absorption
   evidence has ever been represented for the key
VH same-author value head per author for each retained generation
ET causal maxima needed for exact-time canonical provenance
IF complete applicable all-mode invalidate frontier for each retained value origin
HF complete applicable hard frontier for each retained value origin
VV greatest validation per (author,key,generation,retained value origin)
RL future-relevant reset assertion antichain across all tagged anchors and only
   the anchor witnesses referenced by its survivors
RC one canonical evidence carrier per exact
   (key,receiverValueOrigin,sourceGeneration,sourceValueOrigin) relation
```

It then takes the least closure containing each scoped event's generation, each value-specific assertion's origin, every generation's initial freshness event, and event identities/contexts needed to validate retained references. `compact(J)` is exactly that closure. Presence and equal-time seeds are sets of causal maxima. Concurrent maxima are retained even when the current deterministic conflict winner is one member, because a future event may causally dominate only part of the antichain.

Frontiers remain whole sets; compaction cannot combine partial validations. `HF` may contain an older same-author hard member when the all-mode head is soft. Value-specific barriers for losing heads remain only when required by polling, candidate provenance, or future union and never stale another origin.

For assertions on the same NodeKey in state J, define `resetSubsumes(J,N,O)` when `causallyBefore(O,N)` and N's `absorbsThrough` componentwise covers the complete effective `anchorCut(J,K,taggedAnchor(O))`. This relation permits O's fallback assertion to leave RL; it never transfers O's vector to N's anchor. Summary-only coordinates therefore prevent subsumption unless N actually carries them. RL is the global per-key antichain of assertions not subsumed by another assertion, across all tagged anchors, whether currently applicable or displaced. It is not one survivor per retained anchor. Concurrent assertions remain because neither causality nor absorption can be borrowed across them.

Before discarding any carrier, AC computes `anchorCut(A)` from every carrier and incoming cut summary belonging to A for every represented tagged anchor A. It persists that complete join in one canonical non-assertion summary even when no current RL survivor uses A. Therefore a carrier arriving later on A obtains exactly the cut it would obtain if it had been unioned before compaction. This archive is anchor-indexed: an entry never contributes to another anchor during projection. P evaluates each RL result against AC plus its retained same-anchor carriers. Only witnesses referenced by RL/RC survivors enter ordinary exact-reference closure; an AC entry is absorption state rather than an exact-reference seed.

For each exact relation `(key,receiverValueOrigin,sourceGeneration,sourceValueOrigin)`, RC removes causally dominated carriers and retains one canonical carrier from the survivors by occurrence time and author fingerprint. Every carrier states the identical equality fact, so one carrier preserves relation membership; its absorption semantics are not used as RC evidence. The source generation/origin IDs are not local references and do not enter closure. If matching source events independently exist locally, N/P/VH/ET/IF/HF/VV determine their retention. RL and AC independently preserve future-relevant absorption. Physical carrier count does not define c.

## Future-union theorem

Every locally authored event carries forward all observed cross-author causal coordinates. Every successful receive joins the source durable summary, each observed source identity, and each observed immutable context into receiver `causalSummary`, including an import-only semantic no-op. `causalSummary` therefore retains observation closure even if witnessed events are compacted. Consequently a discarded event's causal meaning survives in retained descendants or in the durable summary used by later authoring. If neither retained semantics nor the summary depends on a discarded event, future union can only reintroduce it as an event already dominated by retained context or as a semantically irrelevant non-frontier/non-head event.

Per-author heads and frontiers are monotone under future union. Immutable contexts keep causal domination stable; a future event can dominate some current maxima but cannot make a discarded dominated event maximal without also confronting its retained dominator. Validation vectors monotonically carry same-author/key/generation clearing evidence. RL preserves fallback assertions, AC preserves every represented anchor's complete same-anchor absorption cut, and RC preserves exact correspondence membership without retaining source entries. If O on A is subsumed by N on another anchor, AC(A) remains even when A has no RL survivor. A later carrier C on A therefore receives O's cut coordinates when C is concurrent with N, exactly as in union-before-compaction. AC union is a componentwise join keyed by the exact `(NodeKey,taggedAnchor)`, so delayed union cannot erase or lend absorption. Polling retains per-author maxima. Therefore, for supported histories:

```text
compact(compact(A) union B) = compact(A union B)
```

The equality covers causal presence/value traces, delayed history, freshness, reset fallback, correspondences, and public polling. Merge is associative, commutative, and idempotent.

## Bound

Let n be the number of represented semantic keys, r the number of durable authors, c the number of distinct exact reset correspondence relations required by lagging replicas, and a the number of distinct `(NodeKey,taggedAnchor)` identities whose absorption evidence has been represented. Per-author polling/value/presence evidence and the global RL antichain contribute `O(nr)` events. AC stores one `O(r)` vector for each of the a identities, contributing `O(ar)` coordinates. Event contexts, frontiers, validations, and closure witnesses contribute `O(nr²)`. RC contributes one carrier with `O(r)` coordinates for each relation, or `O(cr)`. Coverage and causal summary contribute `O(r)`.

Thus compacted journal, coverage, causal metadata, and reset-anchor absorption metadata contain `O(nr² + ar + cr)` logical records and coordinates. If b is the maximum byte length of any retained arbitrary-precision coordinate, serialized storage is `O(b(nr² + ar + cr))`.

The a term is necessary. Distinct anchors may carry independent vectors, and an unseen carrier may later arrive concurrently on any one of them. Omitting the exact anchor's vector makes union-after-compaction distinguishable from union-before-compaction; combining vectors across anchors changes projection semantics. Consequently no representation bounded only by n, r, and c can preserve arbitrary exact anchor cuts under unrestricted delayed union. AC collapses repeated evidence for the same anchor componentwise, so its size is independent of assertion count once the set of anchor identities is fixed.
