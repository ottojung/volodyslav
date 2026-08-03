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

Emit `invalidate` for the current selected state event with empty incoming
proof. Repeated invalidation of an already explicitly invalidated node is a
no-op (no entry, no revision, no physical occurrence).

### Explicit deletion

Emit `delete`.

### Upstream staleness

No freshness entry is emitted merely because a node became stale through
upstream propagation. That staleness is derived during graph projection, and its
existing incoming proofs remain available.

---

## 2. Atomic batching

A successful local operation commits in one durable batch:

```text
graph-cache mutations
new logical journal entries
new local physical occurrences
last local physical JournalIndex
```

A failed batch exposes none of them. Journal revisions and origin indices are
allocated during serialized finalization. Several entries created by one
operation may receive consecutive origin indices and, where applicable,
consecutive logical revisions. No host-state version exists.

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

For each semantic node key, compute the complete delta between the previously
installed state and the newly published state, then emit entries:

```text
current unmaterialized, target materialized         -> add
current materialized,   target unmaterialized       -> delete
both materialized,      semantic value changed      -> edit
both materialized,      up-to-date -> stale, explicit -> invalidate
both materialized,      stale -> up-to-date, explicit validate -> validate
```

When more than one condition applies:

- value change plus freshness restoration: `edit`, then `validate`;
- value change plus explicit freshness downgrade: `edit`, then `invalidate`;
- first materialization: `add` only, regardless of initial freshness;
- deletion: `delete` only.

`validate` covers both successful recomputation of an unchanged value and cache
revalidation: it records the exact selected input state events against which the
unchanged cached value is now valid.

`invalidate` is explicit only: it clears the named state event's incoming
validity proofs. Upstream-propagated staleness emits nothing.

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

**P4 — Invalidate clears proofs.** An `invalidate` entry carries an empty proof
map; the named node's incoming validity is removed.

**P5 — Atomic publication.** A reader that observes any new physical occurrence
of a batch also observes the complete batch: the graph-cache mutations, the
entries, the occurrences, and the advanced local `JournalIndex`. A reader that
observes none of them observes all of them as absent.

**P6 — No upstream freshness emission.** Changing only a node's derived
freshness through an upstream change emits no freshness entry for that node.

**P7 — Consecutive revisions.** Entries of one operation receive consecutive
origin indices and, where applicable, consecutive logical revisions; no
interleaving operation can observe a partial batch.
