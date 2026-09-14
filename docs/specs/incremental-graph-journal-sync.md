# IncrementalGraph Journal 3 Synchronization

## Purpose

Journal 3 synchronization replicates immutable journal history and then materializes the deterministic replay projection.

It does not synchronize by rendering the mutable current graph and does not require a second semantic merge algorithm for a special "full sync" case.

The core operation is always the same:

```text
obtain the journal records missing from the receiver
union them into the receiver's retained journal
project the resulting causally closed history
```

A receiver with no history simply has a zero frontier, so an initial/full synchronization is ordinary suffix synchronization starting from zero.

## Preconditions

Journal replication between two states requires:

- an exact compatible Journal 3 record interpretation;
- compatible database version and graph schema for the events being projected;
- valid immutable per-writer streams;
- no conflicting content under one `JournalRecordId`;
- a writable receiver which owns exactly one local writer identity;
- lifecycle/locking exclusion sufficient to publish the imported journal and resulting graph projection atomically.

Transport may be Git-backed, database-backed, direct peer-to-peer, or another implementation. Transport identity does not participate in journal semantics.

## Source and receiver frontiers

Let receiver R retain frontier:

```text
FR
```

and source S retain frontier:

```text
FS
```

For writer A, R is missing the suffix:

```text
(FR[A], FS[A]]
```

when `FS[A] > FR[A]`.

Synchronization requests the actual immutable records in those suffixes. It does not request a current per-node summary as a substitute for them.

## Immutable overlap check

For every writer A and every sequence q retained by both sides, the record under `(A,q)` must have identical canonical meaning.

A disagreement means that one writer identity has forked or storage is corrupt. Synchronization must fail rather than choose one branch by timestamp, payload equality, transport ancestry, or arbitrary source preference.

## Same-writer ownership safety

Suppose R is writable under local writer A.

If a source contains a strictly longer A-authored prefix than R:

```text
FS[A] > FR[A]
```

ordinary synchronization must not silently import that prefix and then continue authoring as though nothing happened.

Such a source proves that later history under R's own writer identity already exists outside R's local allocation frontier. Continuing locally could reuse a durable `(A,q)` identity for different content.

This condition requires a supported same-writer restoration/recovery procedure or explicit fork resolution. The ordinary foreign synchronization operation fails before R appends any new local record.

The rule applies even when the later A records arrive relayed through another writer's replica rather than directly from A's authoritative storage.

## Foreign prefix extension

For every author B distinct from the receiver's own writer, R may extend its retained B prefix by copying the missing immutable B records verbatim.

The imported records remain B-authored:

```text
source B:73
    -> receiver stores B:73
```

Synchronization does not create:

```text
receiver:912 = Adopt(B:73)
```

merely because B:73 became known locally.

If importing B history causes the final projection to require a genuinely new receiver-authored semantic normalization event under a later synchronization specification, that new event is separate from the imported record and is authored under the receiver writer in the ordinary way.

## Causal closure

A source may expose writer suffixes independently, but a receiver may publish a supported target only when all imported semantic-event contexts are covered by the resulting retained frontier.

If an event requires a causal coordinate the receiver does not yet contain, synchronization must fetch the corresponding missing writer prefix before publication.

For example, if event `B:73` contains:

```text
context = {
    A: 50,
    B: 72
}
```

and R contains A only through 47, R must also obtain `A:48..50` before exposing B:73 in a supported committed projection.

The synchronization implementation may discover such dependencies while streaming records. It need not precompute a graph-sized dependency set in RAM.

## Journal union

Once all overlapping identities agree and the required suffix records are available, the information-level result is the immutable prefix union:

```text
F = join(FR, FS)
```

with actual records present through every coordinate in F.

Because supported inputs are prefix-complete and causally closed, and imported contexts are made available before publication, the resulting journal is also prefix-complete and causally closed.

At the journal-information level this union is:

- idempotent;
- commutative;
- associative.

These algebraic properties describe immutable history retention. They do not by themselves prove every IncrementalGraph semantic rule; deterministic projection supplies that second half of convergence.

## Projection after import

After journal union, the receiver computes the Journal 3 replay projection defined by `incremental-graph-journal-replay.md`.

The projection must be based on the complete target journal being committed, not on arrival order or source role.

The receiver then lowers that projection into the unchanged legacy graph sublevels.

An implementation may update only affected indexes/nodes when it can prove equivalence to complete replay. Journal 3 currently imposes no end-to-end asymptotic time bound on this optimization; GitHub issue #1607 owns that future requirement.

## Synchronization-authored semantic events

Copying history is not semantic authoring.

Journal 3 nevertheless permits synchronization to discover that the existing IncrementalGraph operational semantics require a new local semantic transition which is not already represented in the union. Examples may include persistent invalidation/normalization required to preserve the ordinary cache/`oldValue` contract.

When that happens:

1. imported history is first treated as causally observed;
2. the new local event's `context` includes the complete target frontier it relies on;
3. its HLC authority is allocated after the greatest observed authority time;
4. the event is appended under the receiver's own writer stream;
5. replay/projection is recomputed including that new event;
6. the imported records, local event, and final graph projection are published under one supported synchronization cutover.

Such events must be justified individually by the synchronization semantic specification. Synchronization must not emit receiver-local records merely to acknowledge receipt of foreign history.

## No separate full-sync semantic algorithm

Journal 3 does not define a different semantic merge for "full" synchronization.

If receiver R has no retained records for writer B:

```text
FR[B] = 0
```

then synchronization requests:

```text
B:1..FS[B]
```

The same replay projection runs afterward.

If R later has B through 900 and S has B through 905, synchronization requests only:

```text
B:901..905
```

Correctness is the same in both cases because the target journal after union is the same history that would be obtained by transferring the complete prefixes.

## Streamability

Journal synchronization must be implementable without loading the complete journal or complete missing suffix into RAM.

Per-writer missing suffixes should be exposed/consumed as ordered streams of bounded records. Implementations may use bounded buffers and durable staging while assembling a causally closed atomic target.

The absence of a total journal-size bound does not imply that synchronization must materialize unbounded history in memory.

## Stable source publication

A synchronization source must expose immutable records only through a stable published prefix.

For a writer W, transport/storage should conceptually expose:

```text
publishedThrough(W) = q
```

and guarantee that records `W:1..q` are immutable and available as one published prefix.

Records staged beyond q are not synchronization input until the published head advances.

A future dumb remote backend may implement this with an atomic expected-head append:

```text
append(W, expected=q, records=q+1..r)
    -> atomically publish head r
```

The concrete backend mechanism is non-normative. The semantic requirement is that another replica never treats an uncommitted partial writer suffix as durable published history.

## Publication atomicity on the receiver

A receiver may obtain and validate remote records over many network requests, but the active supported database must not expose a target in which:

- the journal union has been committed but the graph projection still describes the old journal; or
- the graph projection reflects imported events which are not durably retained in the journal.

The implementation may stage imported records and an inactive graph target, validate the complete result, durably flush it, and atomically switch active state.

## Synchronization convergence

Assume a finite set of supported replicas and no continuing graph-changing operations.

If synchronization does not require endlessly generating new normalization events, fair repeated exchange eventually causes every replica to retain the same immutable writer prefixes.

Because Journal 3 replay is deterministic:

```text
same retained journal
    => same semantic IncrementalGraph projection
```

After that point, further synchronization transfers no new records and is a semantic no-op.

Any synchronization-authored normalization rule added later must include its own termination/convergence argument so it cannot create an infinite acknowledgement or repair chain.

## Delayed and absent replicas

Correctness does not rely on every host participating, acknowledging history, or eventually returning.

A writer stream remains meaningful if another replica is absent for an arbitrarily long time. A delayed replica may later request the missing immutable suffixes from whatever supported source retains them.

Journal records are not reclaimed merely because currently known replicas appear to have advanced past them.

## Backend relationship

The long-term remote backend is a journal publication/replication store, not the semantic IncrementalGraph merge authority.

It may provide:

- durable immutable writer records;
- per-writer published heads;
- authenticated ownership of appends;
- efficient suffix range reads;
- optional immutable blobs/checkpoints.

The backend need not understand `NodeKey`, freshness, validation, dependency closure, computors, or conflict selection in order to store the journal correctly.

Those meanings belong to Journal 3 replay in Volodyslav.
