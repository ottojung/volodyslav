# Logical journal compaction

Compaction is a canonical function of immutable logical contents; `localIndex` is excluded from logical equality. A later sequence covers an earlier notification only at the same `(author,key,action)` coordinate.

## Canonical retained set

For every key K, retain: (1) every `(author,K,action)` coordinate maximum; (2) the presence maximum and value witnesses for winning add generation G; (3) each author's greatest invalidate scoped to G, reconstructing `invalidateFrontier(K,G)`; (4) each author's greatest validation scoped to G; (5) every exact invalidate named by every retained validation context; and (6) every add named by a retained generation-scoped entry.

Reference closure also applies to coordinate-max validations for losing generations: causal references and add generations MUST remain resolvable. Compaction rejects malformed references and never leaves a dangling one. Losing-generation authority not required above may be discarded because a retained greater presence event prevents it from winning any future union; a future greater add brings its own witnesses.

## Causal dominance

For validations V1 and V2 by one durable author for the same K,G, `V1.sequence < V2.sequence` implies V1's context is componentwise no greater than V2's. The author imports immutable history monotonically, never rolls back through a supported lifecycle, and captures its complete retained frontier at each genuine validation. It therefore never forgets observed invalidate progress. Import enforces this invariant, allowing an older same-author validation to be dominated by the retained later one.

## Preservation and ACI proof

```text
compact(compact(A) union B) = compact(A union B)
```

A discarded coordinate loser cannot beat its retained maximum. A discarded older same-author invalidate cannot re-enter a frontier because its retained later invalidate dominates it. A discarded validation is dominated by a later same-author validation with a componentwise-greater context. Every invalidate referenced by a retained context remains present.

A delayed invalidate becomes a new author frontier or beats that author's retained element. A validation lacking its exact-or-later reference then fails complete-frontier coverage identically whether compaction ran before or after delivery. Partial contexts are never combined. Losing generations cannot regain authority; a future greater add selects an isolated generation and brings its witnesses. These cases exhaust facts later union can make authoritative and prove closure. Canonical selection is deterministic and idempotent; closure plus ACI set union therefore yields commutative, associative, and idempotent merge. This conclusion depends on closure, not merely on union being ACI.

## Cursor preservation and timing

If compaction removes cursor-visible entries for K, its independent atomic transaction touches the greatest retained `notificationWitness(K)` above the old watermark. Its five projections cover every removed possibility, so compaction cannot create an action-specific false negative.

Compaction MAY run after any transaction, during maintenance, as part of synchronization, repeatedly, or at any time. It MAY be skipped for arbitrarily many ordinary mutations. Correctness never depends on timing; a crash before optional compaction leaves a valid uncompacted journal. Compaction is semantics-preserving and idempotent.

## Fully compacted size (not a continuous bound)

Let n count current or historic semantic keys represented by the compacted database/journal, and r count durable authors represented by compacted entries or retained causal references. Finite schema arity and fixed maximum serialized `ConstValue` size make `NodeKey` constant-sized here.

Per key, constant actions times r coordinates use `O(r)` entries. At most `O(r)` retained validations each have an `O(r)` context; exact referenced invalidates contribute at most `O(r²)`. Other generation, value, freshness, and notification witnesses are no larger. Thus:

```text
size(compact(J)) per key = O(r²)
size(compact(J))         = O(nr²)
```

A scalar `localIndex` does not alter the bound. **The guarantee applies only after complete canonical compaction. No operation-count-independent bound is promised for an uncompacted journal.**

## Executable bounded verification

`scripts/verify-journal-spec-model.py` models several authors, generations, causal contexts, delayed and independent invalidates, partial and complete validations, same-author progress, reference closure, projections, closure, and full bounded ACI. It structurally checks quadratic scaling but does not claim to prove the analytical asymptotic bound. Its repeated-mutation trace intentionally shows raw growth while canonical size stays bounded.
