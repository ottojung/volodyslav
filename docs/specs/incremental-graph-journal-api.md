# Possible-change journal API

```text
graph.possibleMaybeChanges({ since, to })
baselinePossibleNodeChange()

PossibleNodeChange { nodeName, bindings, action, time }
```

The result means that this exact closed-classifier action may have happened to
the semantic node after the cursor. It describes history, not current graph
state. Repeated covered occurrences may collapse and false positives are
allowed, but an action-specific false negative is forbidden.

`since` is an opaque receiver-local physical cursor returned in the same
process, or the baseline sentinel. It is not a `JournalEntryId`, is not
serializable or user-constructible, and has no replicated meaning. Each returned
record privately carries its local position. An imported logical entry keeps
its `(sequence,author)` while receiving a fresh local position so newly learned
history can be observed.

A query selects one fixed committed active-replica snapshot, captures its local
watermark, scans `(since,watermark]` in local-position order while skipping
compaction gaps, and applies `NodeFilter`. Selection and snapshot capture cannot
straddle replica cutover. `time` is the immutable logical entry's time.

Inactive construction copies the active local delivery domain exactly; new
local or imported deliveries allocate above its watermark. Consequently an
existing same-process cursor remains meaningful across cutover.
