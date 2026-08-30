# IncrementalGraph journal compaction

Canonical compaction retains these seeds:

```text
N  greatest local sequence per (author,key,publicAction), excluding no-action events
P  each RL survivor's per-anchor result presence and its selecting authority;
   ordinary causal-maximal presence when RL is empty
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

For assertions on the same NodeKey, define `resetSubsumes(N,O)` when `causallyBefore(O,N)` and N's `absorbsThrough` componentwise covers O's `absorbsThrough`. Supported reset authoring that consumes O's future-union semantics carries that absorption evidence into N; causal context alone is insufficient. RL is the global per-key antichain of assertions not subsumed by another assertion, across all tagged anchors, whether currently applicable or displaced. It is not one survivor per historical anchor. Retain only the null/delete/present witnesses referenced by RL survivors. Concurrent assertions remain because neither causality nor absorption can be borrowed across them.

For each exact relation `(key,receiverValueOrigin,sourceGeneration,sourceValueOrigin)`, RC removes causally dominated carriers and retains one canonical carrier from the survivors by occurrence time and author fingerprint. Every carrier states the identical equality fact, so one carrier preserves relation membership; its absorption semantics are not used as RC evidence. RL independently retains every future-relevant absorption assertion under `resetSubsumes`. Repeated statements of one relation therefore collapse to one RC carrier while their strongest distinct future-union absorption remains bounded in RL. Physical carrier count does not define c.

## Future-union theorem

Every locally authored event carries forward all observed cross-author causal coordinates. Every successful receive joins the source durable summary, each observed source identity, and each observed immutable context into receiver `causalSummary`, including an import-only semantic no-op. `causalSummary` therefore retains observation closure even if witnessed events are compacted. Consequently a discarded event's causal meaning survives in retained descendants or in the durable summary used by later authoring. If neither retained semantics nor the summary depends on a discarded event, future union can only reintroduce it as an event already dominated by retained context or as a semantically irrelevant non-frontier/non-head event.

Per-author heads and frontiers are monotone under future union. Immutable contexts keep causal domination stable; a future event can dominate some current maxima but cannot make a discarded dominated event maximal without also confronting its retained dominator. Validation vectors monotonically carry same-author/key/generation clearing evidence. An RL/RC assertion is discarded only behind a causal successor that carries its complete absorption evidence and separately retained exact correspondence facts, so delayed union cannot recover distinct semantics from it. Polling retains per-author maxima. Therefore, for supported histories:

```text
compact(compact(A) union B) = compact(A union B)
```

The equality covers causal presence/value traces, delayed history, freshness, reset fallback, correspondences, and public polling. Merge is associative, commutative, and idempotent.

## Bound

Let n be represented semantic keys, r durable authors, and c distinct exact reset correspondence relations required by lagging replicas. Per-author polling/value/presence evidence and the global RL antichain contribute `O(nr)` events. Each event has an `O(r)` causal context; frontiers, validations, reset absorption vectors, and closure witnesses likewise contribute `O(nr²)` coordinate slots. RC contributes one carrier with `O(r)` coordinates for each relation, or `O(cr)`. Same-author monotone reset churn collapses under `resetSubsumes`, including churn across changing null/delete/present anchors. Coverage and causal summary are `O(r)` and are absorbed by the bound for positive n and r.

Thus compacted journal, coverage, and causal metadata contain `O(nr² + cr)` logical records and coordinates. If b is the maximum byte length of any retained arbitrary-precision coordinate, serialized storage is `O(b(nr² + cr))`. This is an accounting result, not a runtime cap.
