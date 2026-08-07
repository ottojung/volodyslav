# Possible-change journal API

## Surface

```text
graph.possibleMaybeChanges({ since, to })
baselinePossibleNodeChange()

PossibleNodeChange {
    nodeName
    bindings
    action
    time
}
```

`since` is a physical local cursor from a previous result or the baseline
sentinel. `to` is a `NodeFilter`. A result means: **this exact kind of transition
may have happened to this semantic node after the cursor.** It does not assert
current graph state.

Actions have only these meanings: absent-to-materialized `add`; materialized
`ComputedValue` inequality `edit`; materialized-to-absent `delete`; fresh-to-stale
`invalidate`; and stale-to-fresh `validate`. False positives and collapse of
repeated identical actions are permitted; false negatives on these dimensions
are not.

Every `PossibleNodeChange` returned by `possibleMaybeChanges` carries a private
same-process cursor position corresponding to its local `JournalIndex`. The
private cursor position:

- is not one of the public data fields;
- is not directly readable as a raw journal index;
- is not user-constructible from `nodeName`, `bindings`, `action`, and `time`;
- is accepted internally when that returned token is later passed as `since`;
- is valid only within the documented same-process cursor domain; and
- has no persistence or serialization guarantee.

`baselinePossibleNodeChange()` similarly returns an opaque sentinel strictly
before every real local journal position. The implementation representation is
deliberately unspecified. It may use private fields, symbols, nominal branding,
object identity plus private lookup, or another mechanism satisfying this
contract. A raw numeric `JournalIndex` is not part of the public API.

## Fixed-snapshot query

A query performs:

```text
1. acquire shared garden access and select one active graph replica
2. open one fixed committed snapshot of that replica's journal
3. capture watermark H from the snapshot
4. scan DeliveryByIndex over (since,H]
5. skip absent physical indices
6. apply NodeFilter
7. return records in ascending localIndex order
```

Selection, snapshot creation, and watermark capture cannot straddle replica
cutover. The filter affects returned nodes, not cursor allocation. Since there is one record per key/action, the scan returns that physical
record directly after filtering.

`time` is the delivery record time: operation time for a local mutation; the
selected advanced remote component's time for remote progress; or local cutover
time for a graph transition created locally by synchronization.

## Same-process cursor domain

Inactive construction copies `DeliveryByIndex`, `DeliveryHead`, and watermark
exactly from one fixed active snapshot. Gaps remain gaps, new indices are above
the copied watermark, and remote physical history is not imported. Consequently
a cursor issued before cutover remains a valid position afterward.

### Cutover trace

With active watermark 100 and retained indices `{42,88}`, the inactive replica
starts with the same indices, heads, and watermark. If synchronization emits a
record, it receives index 101 or greater. A client cursor at 88 scans the same
local domain after cutover and can observe the new covering record.
