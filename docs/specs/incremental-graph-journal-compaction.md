# IncrementalGraph journal compaction

Compaction is a canonical function over the one immutable journal. It preserves a union of evidence obligations in the same physical collection.

It MUST retain at least:

* the maximum entry for each `(author, NodeKey, public action)` (notification evidence);
* winning presence authority;
* per-author value heads in the winning generation and exact equal-time provenance witnesses;
* every outstanding member of `hardInvalidateFrontier`;
* validation heads required by the effectiveness proof;
* exact hard invalidates referenced by retained validation contexts;
* exact add witnesses referenced by retained generation-scoped entries;
* transitive reference closure and other logical evidence required by presence-before-value selection.

These are independent obligations. With `A10 hard invalidate K; A20 soft invalidate K`, A20 is the invalidate notification maximum while A10 can remain an outstanding hard barrier, so both may be retained.

Compaction never decreases coverage. Deleted exact entries remain covered prefix obligations and can be represented for polling by later same-coordinate maxima. A later union may reintroduce an older exact logical witness needed by reference closure; per-author cursor meaning is unchanged because its identity remains in the already-closed prefix.

For supported reachable states, merge is `compact(A union B)` and is commutative, associative, and idempotent. Canonical future-union closure is mandatory:

```text
compact(compact(A) union B) = compact(A union B)
```

The notification coverage theorem follows from retaining coordinate maxima, making physical compaction observationally invisible to polling.

Let `n` be current or historic semantic keys, `r` durable fingerprints represented by retained evidence or coverage, and `a=5`. Notification maxima are `O(anr)=O(nr)`, hard/validation causal evidence is at most `O(nr^2)`, and coverage is `O(r)`; total compact journal plus coverage is `O(nr^2)`. Each entry carries bounded key, node name, binding environment, and context information under the existing bounded-address/context assumptions. Application cursor tokens are `O(r)` but are not database storage.
