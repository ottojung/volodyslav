# Incremental Graph Journal — Emission

This document defines the local transition-to-entry rules and atomic batching
for host-originated graph operations. It is the only document that describes
how local graph activity produces journal entries.

---

## 1. Entry emission rules

One graph operation may emit several ordinary one-node journal entries. There is
no operation envelope and no operation ID; LevelDB batching provides atomic
publication.

### First materialization

Emit `add` carrying:

```text
complete value/timestamps/identifier
actual initial freshness
actual incoming proof map
```

Initial stale materialization emits only `add`; its payload records
`storedFreshness = "potentially-outdated"`. Initial stale state is not an
`up-to-date -> potentially-outdated` transition, so no `invalidate` is emitted.

### Changed recomputation

Emit `edit` carrying the complete new materialization and current proof map.

### Unchanged recomputation or cache revalidation

Emit `validate` for the current selected state event, carrying the current input
state-event IDs.

### Explicit invalidation

Intent: emit `invalidate` for the current selected state event with `tone =
"potentially-outdated"` and an empty incoming proof map. This removes the named
node's incoming validity proofs.

### Propagated staleness

Intent: when a node becomes stale through recursive upstream propagation, emit
`invalidate` for its current selected state event with `tone =
"potentially-outdated"` **preserving the existing incoming proof map**. The
runtime graph cache marks the node stale, and the journal entry records the same
transition, so cache and projection never diverge.

A dependent becomes fresh only after its own `validate` event for its current
selected state event; validating an input alone does not restore a
propagated-stale dependent.

### Explicit deletion

Intent: emit `delete`.

### Validate

Intent: emit `validate` for the intended subject state event with the intended
input state-event IDs.

The intents above are tentative. They are not authoritative until reconciled
against the current committed assertion inside the darkroom (§ 2).

---

## 2. Host-operation transactions: intent then darkroom reconciliation

One graph operation may emit several ordinary one-node journal entries. There is
no operation envelope and no operation ID; LevelDB batching provides atomic
publication.

A host operation runs in two phases:

```text
transaction body:
    compute operation intent and tentative graph work

darkroom finalization:
    read the current canonical journal
    project the current authoritative assertion
    reconcile the intent against that current assertion
    derive final journal entries
    derive the resulting graph-cache mutation
    allocate indices/revisions
    commit atomically
```

Prepared journal entries are not authoritative until reconciled in the darkroom.
The current committed assertion is read under the darkroom, so two concurrent
transactions serialized there always reconcile against the same, up-to-date
authoritative state.

### 2.1 Explicit invalidation finalization

For the selected state event `S` of the intended node:

```text
current tone = up-to-date
    -> emit invalidate(S, stale, empty proof map)

current tone = stale, current proof map nonempty
    -> emit invalidate(S, stale, empty proof map)

current tone = stale, current proof map empty
    -> no-op
```

An explicit invalidation of a propagated-stale node is NOT a no-op: it removes
the incoming proofs so the next pull must invoke the computor. Only a repeated
explicit invalidation of an already explicitly invalidated state (empty proof
map already selected) is a no-op.

### 2.2 Propagated invalidation finalization

For the selected state event `S` of the intended node:

```text
current tone = up-to-date
    -> emit invalidate(S, stale, current proof map)

current tone = stale
    -> no-op
```

Propagation never replaces an already-selected empty proof map with a preserved
proof map: the explicit-invalidation outcome is monotone and cannot be
un-done by a concurrent propagation.

### 2.3 Validate finalization

Recheck during finalization that:

- the intended `subjectStateEventId` is still selected;
- every intended input state event is still selected;
- every input is materialized and up-to-date.

If any condition no longer holds, do not publish an up-to-date cache state.
Either commit a conservative stale assertion when the underlying operation
semantics require it, or fail/retry according to the existing transaction model.

### 2.4 Commit invariant

Before durable commit, require:

```text
planned graph cache
    == projectGraph(
           schema,
           normalizeJournal(current journal ∪ final entries)
       )
```

The equality covers selected values, materialization, identifiers, timestamps,
freshness, and validity. The graph-cache mutation is derived from the final
entries, never from the tentative graph work alone.

### 2.5 Atomic publication

A successful operation commits in one durable batch:

```text
graph-cache mutations
new logical journal entries
new local physical occurrences
root-local lastLocalJournalIndex
```

A failed batch exposes none of them. Every physical occurrence consumes an
index from the single root-local allocator (`allocateLocalJournalIndex`,
`incremental-graph-journal-types.md` § 2.1). A host-originated event's
`originIndex` is its allocated `LocalJournalIndex`; an imported event or carrier
preserves its `origin`/`eventId` and receives a newly allocated local index.
Logical revisions are scoped per key, category, and subject, so entries of one
operation are not generally "consecutive" across different keys. No host-state
version exists.

### 2.6 Invalidation race test

```
A -> D
D fresh with proof P
```

Two concurrent transactions:

- `X` explicitly invalidates `D`;
- `Y` invalidates `A` and propagates to `D`.

Test both darkroom commit orders:

- **X then Y:** X finalizes first: `D`'s tone is up-to-date, so it emits
  `invalidate(D, stale, empty proof)` and commits. Y finalizes next: `D`'s
  selected assertion is already stale with an empty proof map, so the
  propagated intent is a no-op. Final: `D` stale, `D` incoming proof map empty.
- **Y then X:** Y finalizes first: `D`'s tone is up-to-date, so it emits
  `invalidate(D, stale, P)` (proof preserved) and commits. X finalizes next:
  `D`'s tone is stale with a nonempty proof map, so it emits
  `invalidate(D, stale, empty proof)`. Final: `D` stale, `D` incoming proof map
  empty.

No commit order restores `P`. The explicit-invalidation outcome is monotone and
wins over a later-configured propagation.

---

## 3. Reset

Reset is an ordinary bulk graph operation:

- compare the current projection with the target graph;
- emit ordinary per-key entries;
- commit them in one batch;
- do not install the target journal;
- do not alter journal lineage, cursor domain, or origin identity.

Reset has no journal semantics of its own and no operation ID.

---

## 4. Migration

Migration emits the same ordinary entries and uses the same transition rules
(`incremental-graph-journal-migrations.md`). Migration-generated `add`, `edit`,
`delete`, `invalidate`, and `validate` entries follow the identical emission
matrix and batching discipline.

---

## 5. Transition-to-entry matrix

For each semantic node key, compare the **complete journal-projected
assertion** — not merely observable value and freshness — between the
previously installed state and the newly published state, then emit entries:

```text
current unmaterialized, target materialized               -> add
current materialized,   target unmaterialized             -> delete
both materialized,      semantic value changed            -> edit
both materialized,      state identity changed            -> edit (or delete+add)
both materialized,      proof map changed                 -> validate / invalidate
both materialized,      up-to-date -> stale, explicit     -> invalidate (empty proof)
both materialized,      up-to-date -> stale, propagated   -> invalidate (preserved proof)
both materialized,      stale -> up-to-date, explicit validate -> validate
```

The authoritative assertion is:

```text
value
identifier and timestamps, where logically relevant
stored freshness
input proof map under the current schema
```

When more than one condition applies:

- value change plus freshness restoration: `edit`, then `validate`;
- value change plus explicit freshness downgrade: `edit`, then `invalidate`;
- proof-map change only: the applicable freshness entry
  (`validate` for up-to-date, `invalidate` for stale);
- first materialization: `add` only, regardless of initial freshness;
- deletion: `delete` only.

`validate` covers both successful recomputation of an unchanged value, cache
revalidation, and a proof-map change under a fixed state: it records the exact
selected input state events against which the unchanged cached value is now
valid.

`invalidate` is emitted for explicit invalidation (empty proof map) and for
recursively propagated invalidation (preserved proof map). Upstream-propagated
staleness is therefore represented in the journal, never silently dropped. All
emission intents are reconciled against the current committed assertion in the
darkroom (§ 2), which applies the exact finalization rules for explicit
invalidation, propagated invalidation, and validate.

An operation may emit nothing only when the resulting authoritative assertion is
unchanged. A representation-only `OVERRIDE` can remain journal-silent only when
the journal stores the same logical `ComputedValue` and the new physical
encoding is purely a rebuildable-cache concern.

---

## 6. Testing properties

**P1 — Add carries complete assertion.** An `add` entry carries the full
materialization: value, `createdAt`/`modifiedAt`, `storedFreshness`, and the
exact `validInputStateEvents` map.

**P2 — Edit carries the complete new assertion.** An `edit` entry is
self-contained: the value, timestamps, identifier, freshness, and proof map all
describe the new state, never a delta against the old state.

**P3 — Validate is scoped.** A `validate` entry names exactly one
`subjectStateEventId` and records the input state-event IDs validated against.
It can never apply to a different selected state event.

**P4 — Invalidate carries tone and proof map.** An explicit `invalidate` entry
carries `tone = "potentially-outdated"` with an empty proof map; a propagated
`invalidate` entry carries the same tone while preserving the node's existing
incoming proof map.

**P5 — Atomic publication.** A reader that observes any new physical occurrence
of a batch also observes the complete batch: the graph-cache mutations, the
entries, the occurrences, and the advanced local `JournalIndex`. A reader that
observes none of them observes all of them as absent.

**P6 — Propagated staleness is journaled.** When a node becomes stale through an
upstream change, an `invalidate` entry for its current selected state event is
emitted with its existing proof map preserved, so the runtime graph cache and
the journal projection agree.

**P7 — Freshness requires the node's own validate.** Validating an input alone
never restores a propagated-stale dependent; the dependent becomes fresh only
after its own `validate` entry for its current selected state event.

**P8 — Darkroom reconciliation.** Final entries are derived from the current
committed assertion read under the darkroom, never from a stale prepared
assertion; the planned graph cache equals
`projectGraph(schema, normalizeJournal(current ∪ final entries))`.

**P9 — Explicit invalidation is monotone.** A propagated invalidation can never
replace an already-selected empty proof map; the explicit-invalidation outcome
wins in every darkroom commit order.

**P10 — Assertion-compared transitions.** A transition emits nothing only when
the complete authoritative assertion (value, logically relevant identifier and
timestamps, stored freshness, input proof map) is unchanged.
