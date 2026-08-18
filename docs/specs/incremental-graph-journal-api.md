# IncrementalGraph journal polling API

This document normatively specifies `graph.possibleMaybeChanges({ since, to })`.

## Change and cursor

The visible result is unchanged:

```text
PossibleNodeChange = { nodeName, bindings, action, time }
action = "add" | "edit" | "delete" | "invalidate" | "validate"
PossibleChangeCursor = Map<DatabaseFingerprint, uint64>
```

A missing cursor coordinate is zero. `cursor[A]=n` means this consumer has accounted for A-authored notification obligations through n. It does not claim literal receipt of every exact event, nor host coverage. A structurally valid cursor is portable to every host and is never rejected merely because it exceeds that host's coverage. A fabricated cursor can skip the fabricator's work; it is progress data, not a security capability.

The opaque string token is versioned and contains the visible change payload needed for round-trip plus the complete hidden cursor vector. Encoding sorts coordinates by fingerprint. Decoding rejects duplicate or malformed fingerprints, malformed uint64 values, invalid payloads, unknown versions, trailing/unknown fields, and every non-canonical encoding. It contains no host identity or scalar journal position. Serialized tokens are `O(r)` application data.

## Snapshot algorithm

For the fixed query snapshot:

1. choose the greatest-sequence entry for each `(author, NodeKey, public action)`;
2. retain E iff `E.sequence > since[E.author]`;
3. apply `to` to E's self-contained `nodeName` and `bindings`;
4. sort deterministically by `JournalEntryId=(sequence,author)`, which is monotone within every author;
5. return E's exact action and time.

Soft and hard invalidates share the public `invalidate` coordinate. No event projects to an action that did not happen.

Starting with the input vector, processing E updates only `cursor[E.author]=E.sequence`; the result privately carries that cumulative vector. Therefore persisting the token on any processed prefix and resuming cannot lose a later same-filter obligation: within an author, every remaining result has a greater sequence, while other coordinates were not advanced past unprocessed events.

Filtering retains the deliberate existing limitation: if no matching result is returned, no continuation token is exposed. There is no separate scan cursor.

## Coverage theorem and traces

If covered event `E=A_s:(K,action)` is unseen, compaction can delete it only while retaining `W=A_t:(K,action)` with `t>=s`. Thus `cursor[A] < s <= t`, and W remains visible subject to the same filter. Consequently virtual and physical notification reduction agree:

```text
possibleMaybeChanges(J,cursor,filter)
 = possibleMaybeChanges(compact(J),cursor,filter)
```

For `A1=edit X, A2=edit Y, A3=edit X` and cursor A=0, both sides return `A2 edit Y, A3 edit X`.

A cursor `{A:10,B:3}` works unchanged on coverage `{A:7,B:100}`: later A8..A10 are intentionally accounted, while B4..B100 remain eligible. `{A:10,B:3}` and `{A:10,B:0}` distinguish consumers with the same apparent latest A event. Hosts learning A1/B1 in opposite orders require no shared global order; their vectors record independent prefixes.
