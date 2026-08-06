# Notification journal emission

## Transition classifier

For every successful local transaction, compare authoritative committed states:

```text
before = graph state before the transaction
after  = graph state after the transaction
ActionsByKey = classifyGraphTransition(before, after)
```

For each semantic key, classification is exhaustive and exact:

1. absent to materialized: `add` only;
2. materialized to absent: `delete` only;
3. both materialized: emit `edit` iff values differ under normative
   `ComputedValue` equality; independently emit `invalidate` for fresh-to-stale
   or `validate` for stale-to-fresh.

No net change in materialization, value, or freshness emits nothing. Intermediate
states inside the atomic transaction are not committed transitions.

## Clock advancement

For each `(key, action)` in `ActionsByKey`:

```text
component = clock[key][localJournalOrigin][action]
newComponent = {
    sequence: component.sequence + 1
    time: operation time
}
```

The durable transaction-finalization boundary serializes advancement. One local
origin cannot publish different components with the same sequence at a
coordinate. Increment at `uint64` maximum is a fatal capacity failure; wrapping
is forbidden.

## Append or replace

Publishing `(K,A)` is mandatory online replacement:

```text
1. previousIndex = DeliveryHead[K,A], if present
2. allocate localIndex > lastLocalJournalIndex
3. in the transaction's atomic LevelDB batch:
   delete DeliveryByIndex[previousIndex], if present
   put DeliveryByIndex[localIndex] = DeliveryRecord
   put DeliveryHead[K,A] = localIndex
   set lastLocalJournalIndex = localIndex
```

Indices are never reused and the watermark never decreases. The graph mutation,
all clock advances, all replacements, all heads, and the watermark commit in one
durable batch. One transaction may cover many keys and actions.

There is no operation ID, journal transaction, batch ID, event envelope, or
causal metadata.

## Normative local traces

| Before | After | Notification |
|---|---|---|
| absent | present, fresh | `add` |
| absent | present, stale | `add` only |
| present value A | present value B, same freshness | `edit` |
| present value A | recomputed A, same freshness | none |
| present, any freshness | absent | `delete` only |
| present fresh | present stale, same value | `invalidate` |
| present stale | present stale after repeated invalidation | none |
| present stale | present fresh, same value | `validate` |
| present fresh | validation work, remains fresh | none |
| A/fresh | B/stale | `edit`, `invalidate` |
| A/stale | B/fresh | `edit`, `validate` |

Identifier-only, timestamp-only, validity-edge, proof, dependency metadata, and
representation-only changes emit nothing when the three observable dimensions
are unchanged.

## Local no-false-negatives argument

A committed exact transition and its clock advancement and delivery replacement
share one atomic batch. A committed transition therefore cannot exist without a
covering record and synchronized progress. Aborted transactions expose neither.
