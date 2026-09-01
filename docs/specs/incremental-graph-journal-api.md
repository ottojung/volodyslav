# IncrementalGraph consumable journal iterator API

## Public API (normative)

`PossibleChange` is notification data with exactly these visible readonly fields:

```ts
type PossibleChange = Readonly<{
    nodeName: NodeName;
    bindings: readonly ConstValue[];
    action: "add" | "edit" | "delete" | "invalidate" | "validate";
    time: UnixTimestamp;
}>;

interface JournalIterator {
    iterate({ pattern }: { pattern: NodeFilter }): Promise<Array<PossibleChange>>;
    clone(): JournalIterator;
}

graph.journal.makeIterator(): JournalIterator;
iteratorToString(iterator: JournalIterator): string;
graph.journal.iteratorFromString(state: string): Promise<JournalIterator>;
```

The notification contains no journal ID, writer, generation, causal context,
invalidation mode, reset metadata, filter identity, progress, issuance evidence,
or other continuation state. It is data and is neither nominal nor a capability.
Internal reset-observation entries have no public projection. Soft and hard
invalidation both project to `"invalidate"`.

`makeIterator()` creates a consumer before all journal history. Progress belongs
to the iterator and is a vector of per-`DatabaseFingerprint` coordinates;
missing coordinates mean zero. It is independent of every `NodeFilter`.
Every iterator is permanently bound to the graph context that created or
restored it. `iterate()` therefore accepts no graph argument, `clone()` retains
the same binding, and transferring progress to another graph requires durable
serialization followed by that graph's coverage-checked `iteratorFromString()`.

## Iteration (normative)

At the start of `iterate`, the journal captures one stable journal snapshot and
its `journalCoverage` frontier `S`. Let `P` be the iterator progress at entry.
The call scans the complete per-author range `(P,S]`. From that fixed snapshot,
it selects the greatest local sequence per
`(author,NodeKey,publicAction)` in the range, filters those representatives with
the supplied self-contained-address `NodeFilter`, orders the result by
`(author,sequence)`, and materializes their public projections. Author ordering
is deterministic only; sequence magnitude is compared only within one author
and makes no cross-author temporal or causal claim.

On successful completion, the iterator progress becomes the componentwise
maximum of `P` and `S`, including coordinates represented only by unmatched or
compacted-away entries. Thus an empty result consumes the entire captured
range, and changing the filter on a later call does not revisit skipped entries.
Events and coverage received or authored after `S` was captured belong to a
later call; iteration never chases a growing tail.

The eager array and progress publication form one atomic consumption boundary.
The implementation computes the complete result before publishing progress. If
snapshotting, scanning, filtering, projection, or materialization fails,
progress remains `P` and no partial result is returned.

Only one `iterate` may be active on an iterator. An overlapping call fails
immediately with `JournalIteratorBusyError`, before capturing or changing
progress. `clone()` synchronously copies the exact current progress and issuance
coverage into independent mutable state. Advancing either clone has no effect on
the other; callers use clones for parallel independent consumers and replay
points.

## Durable iterator-state v1 codec (normative)

`iteratorToString` serializes the iterator's progress and its recorded issuance
coverage, never a `PossibleChange` or filter. `iteratorFromString` asynchronously
parses the state in the receiving graph's active-replica context and restores an
independent iterator bound to that graph.
There is exactly one v1 encoding:

```text
JSON.stringify({v:1,progress:P,issuanceCoverage:I})
```

Members occur in exactly that order with no insignificant whitespace. `P` and
`I` are arrays of `[fingerprint,coordinate]`, strictly ascending by fingerprint.
Fingerprints match `/^[a-z]{16}$/`. Coordinates are JSON strings containing
canonical positive decimal integers; zero coordinates are omitted and missing
coordinates mean zero. Coordinates are arbitrary precision and are decoded
directly to `BigInt`, never through `Number`. Empty arrays are valid for the
before-all/empty-coverage state. `I` MUST componentwise dominate `P`.

The decoder accepts only the exact object shape and version, validates the
fingerprint grammar, arrays, ordering, uniqueness, decimal spelling, and vector
relation, reconstructs the canonical object, and requires its exact
`JSON.stringify` result to equal the input. Malformed, noncanonical, unknown-
version, or unknown-field input throws `InvalidJournalIteratorStateError`.
Fingerprint collisions have the same consequence as elsewhere in the journal:
the safety guarantees require each fingerprint to denote the same durable
writer history in issuer and receiver.

`issuanceCoverage` records the coverage frontier that proves the published
progress safe. It is empty for a newly created before-all iterator and becomes
the captured coverage when iteration successfully advances. Before restoration
is usable, the
receiving journal's current `journalCoverage` MUST componentwise dominate it;
otherwise `iteratorFromString` throws `InsufficientIteratorCoverageError` and
creates no iterator. This prevents progress `A:100` from skipping `A:51..100`
on a replica covered only through `A:50`. Synchronization can later establish
the missing coverage, after which the unchanged string can be restored.
Comparisons are componentwise by author only.

Iterator progress (consumer consumption), `journalCoverage` (complete possessed
prefixes), `causalSummary` (happened-before knowledge), and issuance coverage
(restore evidence) are distinct. Synchronization changes journal coverage and
causal summary but never application-owned iterator progress. A successful
iteration updates progress and records the captured coverage as issuance
evidence.

## Persistence, migration, and compaction

Restart, checkpoint restoration, and compaction preserve immutable writer
coordinates, so an encoded iterator retains its meaning without rebasing.
Migration preserves iterator meaning whenever it preserves journal writer
histories and coordinates; a migration that cannot do so MUST explicitly reject
that iterator-state version rather than reinterpret it. There is no baseline
token: a newly made iterator is the natural before-all consumer.

For iterator progress `P` and captured frontier `S`, compaction MUST preserve
every required matching public notification in `(P,S]` and iteration over the
physical compact journal MUST advance to `S`, even when retained entries do not
reach every coverage coordinate. Per-`(author,NodeKey,publicAction)` retained
representatives satisfy this because each representative is at least as new as
every removed member of that exact obligation group. Progress advancement uses
the captured coverage frontier, not returned notifications or retained-entry
maxima. Compaction never renumbers or rebases iterator state.
