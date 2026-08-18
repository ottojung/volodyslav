# IncrementalGraph journal compaction

For supported J, compaction is the exact canonical survivor algorithm below. `greatest` uses sequence per author or JournalEntryId as stated.

```text
N = { greatest E per (author,key,publicAction(E))
      where publicAction(E) != null }
P = { presenceHead(J,K) | defined }

For each K whose presenceHead is generation G:
  VH = { valueHead(J,K,G,A) | defined per A }
  CE = { candidate value heads sharing an exact time }
  IF = { invalidateFrontier(J,K,G)[A] | defined per A }
  HF = { hardInvalidateFrontier(J,K,G)[A] | defined per A }
  VHeads = { greatest validation per (author,K,G) }
```

Let Seeds be exactly the union of N, P, VH, CE, IF, HF, and VHeads. Compute the least reference closure R by repeatedly adding (a) the exact GenerationJournalEntry named by every retained scoped entry, (b) each retained generation’s exact `initialFreshness` event, and (c) every exact invalidate named by retained validation contexts. Then `compact(J)=R`; every entry outside R is discarded. No implementation-selected superset is permitted.

A null-public-action generation fence survives as P/VH or reference authority, never as a polling coordinate. Every retained scoped event retains its exact generation. The distinct IF/HF seeds retain later soft notification maximum and older outstanding hard authority when both matter. Generation initial freshness witnesses survive explicitly through generation reference closure, even when a later same-author freshness event is the polling/frontier head.

## Canonical Compaction/Future-Union Theorem

Domain: supported precise journals. Dominated polling/value/frontier heads cannot regain authority; losing generations remain presence-inapplicable; validation contexts are same-author monotone; exact reference closure is retained. Therefore:

```text
compact(compact(A) union B) = compact(A union B)
```

Compaction is idempotent and `merge(A,B)=compact(A union B)` is commutative, associative, and idempotent. Equal logical input uniquely determines byte-identical physical survivors, including uncompacted-source/compact-receiver/reverse receive.

Old exact witnesses may reappear from delayed B reference closure without cursor breakage because their immutable author sequences lie in already-closed prefixes.

## Storage

For n represented semantic keys, r represented authors in evidence or coverage, and five public actions, notification/value/frontier heads are O(nr), causal validation/reference evidence O(nr²), and coverage O(r). Bounded self-contained addresses preserve the factor. Globally:

```text
compact journal + coverage = O(nr² + r)
```

For n>0,r>=1 this is O(nr²); for n=0 journal is empty while coverage may be O(r). Application cursor tokens are not database storage.
