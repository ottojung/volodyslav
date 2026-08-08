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
delivery at B's materialization/cutover time, referring to A's already-known
entry by `causeId`. The client observes the
absent-to-materialized transition without any new logical add.

A query selects one fixed committed active-replica snapshot, captures its local
watermark, scans `(since,watermark]` in local-position order while skipping
compaction gaps, and applies `NodeFilter`. Selection and snapshot capture cannot
straddle replica cutover. The public fields are read directly from the retained
`DeliveryRecord`; queries MUST NOT dereference `causeId`. Logical compaction
therefore cannot make a delivery unreadable or change its public fields.

Delivery action and time always describe the same reported occurrence:

* **Newly learned history without a graph transition:** `action` and `time` are
  copied from the previously unseen logical entry, and `causeId` is that entry's
  ID. This reports the historical occurrence.
* **Actual receiver graph transition:** `action` is the exact closed-classifier
  action from receiver before-state to after-state, `time` is the receiver's
  transition/cutover wall time, and optional `causeId` names the logical event
  responsible. The cause's original action/time do not replace the public
  receiver-transition fields.

When synchronization authors delete or invalidate while performing the local
transition, the occurrences are atomic and naturally have
`logicalEntry.time == DeliveryRecord.time == transition/cutover time`.

### Delayed-application trace

At t1 A authors logical edit E for D. At t2 B learns E, cannot materialize D,
delivers `{action: edit, time: t1, causeId: E.id}`, and the client advances its
cursor. At t3 other synchronization makes E's value admissible and B performs
`absent -> materialized`. The new delivery is:

```text
DeliveryRecord {
    action: "add"
    time: t3
    causeId: E.id
}
```

It is not `{action: add, time: t1}`. The cause remains old and immutable while
the public action/time describe B's new local occurrence.

Every required delivery uses the append-or-replace operation from the journal
types specification. If old record d for `(K,A)` is replaced by r, then `r > d`:

```text
cursor < r:  a subsequent scan can observe the covering record at r
cursor >= r: the cursor has already crossed the covering notification at r
```

The replacement batch is atomic, so a fixed snapshot sees the old headed record
or the new headed record, never neither. Deleting d cannot create an
action-specific false negative. Its physical gap is expected and scans skip it.
Repeated delivery therefore does not make `DeliveryByIndex` grow with operation
or synchronization history.

Inactive construction copies the active local delivery domain exactly; new
local or imported deliveries allocate above its watermark. Consequently an
existing same-process cursor remains meaningful across cutover.
