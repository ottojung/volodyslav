# Mandatory bounded delivery replacement

## One-head invariant

At all committed snapshots, at most one `DeliveryByIndex` record exists for each
historic `(NodeKey, JournalAction)`, and `DeliveryHead` points to it. Every
emission performs append-or-replace: it deletes exactly the superseded record,
adds a fresh-index record, and changes its head atomically. This is mandatory
online compaction, not optional cleanup.

The complete delivery journal is never replaced, truncated, or imported from a
remote. Compaction concerns only the physical delivery indexes described here.

## Cursor coverage proof

Suppose the record at `d` is replaced at `r`, where `r > d`:

```text
cursor < r:  a query can observe the covering record at r
cursor >= r: the cursor has already crossed the covering notification at r
```

The replacement batch is atomic. A fixed snapshot sees the old record or the
new record, never neither. Gaps left at `d` are expected and scans skip them.
This preserves action-specific no-false-negatives while bounding retained
records by `5 × n`.

### Trace

A cursor at 40, old `edit[K]` at 41, and replacement at 57 yields a scan through
watermark 57 that sees 57. A cursor at or above 57 already includes the newer
covering position. A snapshot taken across replacement sees either index 41 and
the old head or index 57 and the new head.

## Continuous size guarantee

One million edits of one node leave one `edit` delivery head and one retained
`edit` record, while its local-origin clock component reaches one million. A
value growing from one byte to many megabytes changes no journal record size,
because delivery and clock state contain no value. Thus bounds hold continuously
and do not depend on future maintenance.
