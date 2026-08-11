# Logical journal compaction

## Proof domain

This specification uses the
[journal supported-state boundary](incremental-graph-journal-types.md#supported-state-boundary),
which inherits the lifecycle definition in `database-lifecycle.md`. Every
preservation, dominance, freshness, closure, and merge claim below quantifies
over supported reachable journal states and deliveries/unions that are
supported protocol states, not arbitrary sets of fabricated entries.
Compaction need not preserve discarded evidence solely to diagnose a past or
future corrupted/unsupported history.

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
`JournalEntry` values. The conclusion does not follow from union alone. Logical
equality excludes local indexes.

## Fully compacted bound and optional timing

Let n be the number of current or historic semantic keys represented by the
compacted journal, and r the number of durable authors represented by
compacted entries or retained causal-context references. The storage model
assumes C, the maximum serialized size of one `ConstValue`; K, the maximum
serialized size of one `NodeKey`; and d, the maximum number of distinct direct
semantic inputs of any node, are fixed system constants independent of n and r.
These are deliberate premises, not type-system conclusions. The recursive
semantic `ConstValue` type does not establish C. The implementation-defined
`NodeKey` identity contract does not bound encoding overhead and therefore does
not establish K. Fixed schema arity, bounded C, and an intended bounded-overhead
key encoding are compatible with bounded K, but K is itself an explicit
premise. Graph finiteness does not establish d because in-degree may grow with
n.

Per key, constant actions times r coordinates use `O(r)` entries. There are at most `O(r)` retained validations relevant to generation/coordinate structure, each carrying `O(r)` context; exact invalidate references contribute at most `O(r²)`. Other journal generation, freshness, and notification witnesses are no larger. Therefore `size(compact(J)) = O(nr²)`, asymptotically in n and r under fixed K. Its hidden constants may depend on K, the fixed number of journal action classes, the fixed maximum serialized `DatabaseFingerprint` size F, and fixed-width `UnixTimestamp`, sequence, local-index, and `JournalEntryId` scalar coordinates. It does not claim independence from arbitrarily growing key or fingerprint encodings: fixed F is an explicit journal storage-model assumption. One scalar `localIndex` per retained entry does not change the bound.

Persisted graph dependency/validity relationships and per-input evidence are
outside `J`. Their per-node width is bounded in the broader storage model under
fixed d, but d is not a premise needed to count the logical compacted journal.
This specification does not state a total byte bound for persisted graph state;
such a bound would also need to account for `ComputedValue` payload size.

**This applies only to complete canonical compaction. No operation-count-independent bound is promised for an uncompacted journal.** Ordinary mutations may append without compacting. Compaction may run after any transaction, during maintenance or synchronization, repeatedly, at any time, or be skipped for arbitrarily many mutations. Correctness is timing-independent; a crash before optional compaction leaves valid uncompacted history. An independent compaction transaction atomically performs the witness touch described above.

## Executable bounded verification

`scripts/verify-journal-spec-model.py` uses one combined six-atom bounded
supported-state universe rather than a freshness-only universe. Its composite
atoms preserve every materially distinct supported class while keeping ACI
exhaustive within that universe: competing generations and an intervening
delete; losing coordinate maxima and winning edit witnesses; cross-author
heads; two-author split invalidation knowledge; complete validation; a delayed
later same-author hard invalidate; later complete validation; and generation
replacement.

It checks 64 supported combined states and all 64 resulting compact states, 64
projection-preservation/idempotence checks, 4,096 supported-universe closure
pairs, and 262,144 compact supported-universe ACI triples. Projections include
presence/generation, value heads, equal-time canonical inputs, invalidate
frontier, effective-validation existence, add references, and causal
references. Negative cases exercise defensive validation of malformed variants,
observation-order violations, and backward same-author contexts; they are not a
completeness proof for corruption detection.

The independent cursor model remains exhaustive and now covers 20,736
four-operation words and 82,944 committed prefixes, carrying 189,449
action-specific obligations through later prefixes. It covers unknown
installation, two keys, repeated touches, stale and partial-action cursors,
synchronization and migration stale→stale hardening, settled repetition without
endless barriers, combined graph transition plus compaction, settled no-op,
index uniqueness, and watermark coverage. A repeated same-key trace has 41 raw
records and two after canonical compaction. These finite structural checks
support, but do not prove, the analytical `O(nr²)` result. The executable model
counts retained records and causal/context references in a finite universe; it
does not prove byte bounds for arbitrary `ConstValue` or `NodeKey` payloads or
establish a universal graph in-degree bound. The journal byte-size conclusion
additionally relies on the analytical fixed-K assumption above. Fixed C and d
remain premises of the broader storage model, not facts proved by the verifier
or steps required to count `compact(J)`.


Occurrence `time` remains immutable payload on every retained entry. Value-head
and candidate-event proofs retain the exact equal-time inputs satisfying
`E.time == toUnixTimestamp(graph.modifiedAt)`. This does not change the
`O(nr²)` compacted bound.
