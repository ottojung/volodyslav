# IncrementalGraph journal compaction

Compaction is the following exact canonical function over a supported journal J. Every `greatest` comparison uses sequence within an author and `JournalEntryId` otherwise; ties therefore have one immutable answer.

## Canonical survivor algorithm

Construct seed sets:

```text
N = { greatest entry for each (author,key,public action) }
P = { presenceHead(J,K) | defined for each K }

For each K whose presenceHead is add G:
  VH = { valueHead(J,K,G,A) | defined for each A }
  CE = { E in candidateEvents(J,K,G) | another candidate has E.time }
  IF = { invalidateFrontier(J,K,G)[A] | defined for each A }
  HF = { hardInvalidateFrontier(J,K,G)[A] | defined for each A }
  VHeads = { greatest validation by each (author,K,G) }
```

`CE` is derived solely from immutable candidate contents. It explicitly names the exact equal-time provenance inputs; it is already a subset of VH, but naming it makes that proof obligation explicit and guards future changes to the value-head rule.

Let `Seeds = N union P union VH union CE union IF union HF union VHeads` over all winning generations. Compute the least fixed-point reference closure R:

1. start `R=Seeds`;
2. for every retained generation-scoped entry, add its exact same-key add generation;
3. for every retained validation, add every exact invalidate named by `clearsInvalidates`;
4. repeat 2–3 until no entry is added.

Then, exactly:

```text
compact(J) = R
```

Every entry outside R is discarded. There is no implementation-selected superset. Thus equal logical input yields byte-identical survivor IDs and contents.

N preserves polling. P enforces presence-before-value. VH and CE preserve winning value projection and exact equal-time provenance. IF preserves all-mode freshness causality; HF separately preserves an older outstanding hard barrier when a later soft invalidate is the all-mode maximum. VHeads and their exact references preserve non-combinable validation proofs. Generation closure keeps every scoped survivor structurally valid.

Example: with A10 hard invalidate and A20 soft invalidate for one generation, IF and N select A20 while HF selects A10; both survive. A validation that cleared A10 but not A20 proves non-hard stale-soft, not fresh.

## Algebra

On supported reachable histories, discarded entries are dominated permanently for every seed coordinate, are scoped to permanently losing presence generations, or are superseded validation contexts whose same-author monotonicity cannot later regress. Reference closure retains every exact target a future seed can currently name. Therefore adding supported B after compacting A selects the same seeds and least closure as adding B before compaction:

```text
compact(compact(A) union B) = compact(A union B)
```

This future-union closure gives idempotence. Defining merge as `compact(A union B)` plus set-union commutativity/associativity gives commutative, associative, idempotent merge on the supported domain. It also makes uncompacted-source to compact-receiver to reverse-receive converge to one physical compact journal.

Old exact witnesses can reappear from B when B retained them as references. Their immutable IDs remain within already-covered author prefixes, so reappearance cannot invalidate a vector cursor.

## Storage theorem

Let `n` be current or historic semantic keys represented by compact evidence, `r` durable authors represented by retained evidence or coverage, and `a=5`. N is `O(anr)=O(nr)`; presence/value/frontier heads are `O(nr)`; validation contexts and their exact referenced invalidates are `O(nr²)`; generation/reference closure is within the same bound. Self-contained bounded addresses multiply by a bounded byte factor. Coverage is `O(r)`.

The globally valid bound is:

```text
compact journal + coverage = O(nr² + r)
```

For `n>0` and `r>=1`, this reduces to `O(nr²)`. For `n=0`, the journal is empty but coverage may remain `O(r)`. Application-owned `O(r)` cursors are not database storage.
