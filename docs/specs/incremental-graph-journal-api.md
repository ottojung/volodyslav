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

Learning history and applying it are separate delivery causes. If an entry was
delivered when learned but a later synchronization uses it to create an
observable local graph transition, that transition MUST receive another fresh
local position above the current watermark. The delivery references the same
immutable logical entry by optional `causeId`; it does not re-author it. Its
self-contained exposed action is the exact receiver transition classified
against the committed before/after graph.

For example, B may learn A's add for D while D is unsupported and remains
absent, then a client advances its cursor. If later input convergence makes the
same revision coherent and B materializes D, B creates a fresh local `add`
delivery referring to A's already-known entry. The client observes the
absent-to-materialized transition without any new logical add.

A query selects one fixed committed active-replica snapshot, captures its local
watermark, scans `(since,watermark]` in local-position order while skipping
compaction gaps, and applies `NodeFilter`. Selection and snapshot capture cannot
straddle replica cutover. The public fields are read directly from the retained
`DeliveryRecord`; queries MUST NOT dereference `causeId`. `time` is copied from
the causal logical entry when one exists, or is the local transition time for a
locally derived delivery. Logical compaction therefore cannot make a delivery
unreadable or change its public fields.

Inactive construction copies the active local delivery domain exactly; new
local or imported deliveries allocate above its watermark. Consequently an
existing same-process cursor remains meaningful across cutover.
