# Incremental Graph Journal — Public API

This document defines the public query API and its conservative notification
semantics over local physical occurrences.

---

## 1. Public surface

Preserved public API:

```text
graph.possibleMaybeChanges({ since, to })
baselinePossibleNodeChange()
PossibleNodeChange fields:
    nodeName
    bindings
    action
    time
```

`PossibleNodeChange` is the public unit of journal observation and can be passed
as `since` to a later `possibleMaybeChanges` call in the same API context. The
journal specifies only same-process, in-memory token usage.

---

## 2. Query semantics

The query proceeds as follows:

1. acquire shared garden access;
2. capture the local physical watermark `H`;
3. scan physical occurrences in `(since, H]`;
4. skip absences;
5. apply `NodeFilter`;
6. deduplicate repeated occurrences of the same event ID;
7. retain at most the greatest local occurrence per key and category within the
   scanned suffix;
8. order by ascending local physical index;
9. return public projections.

A returned action is a conservative possible-change notification. It does not
assert current graph state, so carrier copies are legitimate: a duplicate
occurrence of a canonical event may be reported again even though the underlying
logical event is unchanged.

---

## 3. Cursor tokens

Private same-process cursor tokens are supported. A `PossibleNodeChange`
returned during a process session is valid as `since` for subsequent calls
within that same session. Persistence of tokens across process restarts,
synchronization boundaries involving heterogeneous hosts, or migration/schema
boundaries, and the corresponding long-lived validity guarantees, are outside
this journal's token contract.

`baselinePossibleNodeChange()` returns a position less than any real local
physical index.

---

## 4. Node filters

Node filters are immutable. Filtering is applied per returned change; filters
never alter the logical journal, physical occurrences, or revisions.
