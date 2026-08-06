# Incremental Graph Journal — Synchronization Join and Graph Projection

This document defines the entire logical synchronization merge
(`joinJournal`), the deterministic graph projection (`projectGraph`), the
installation procedure, physical notification carriers, and the normative
traces. It is the only document that describes synchronization.

---

## 1. Synchronization join

Define:

```text
joinJournal(A, B) =
    normalizeJournal(
        logicalEvents(A) ∪ logicalEvents(B)
    )
```

This is the entire logical synchronization merge. There is no candidate set, no
merge basis, no causal frontier, no provenance comparison, and no retained
evidence beyond the canonical journal entries themselves.

**PROP-JS-01 (Commutative):**

```text
joinJournal(A, B) = joinJournal(B, A)
```

because set union is commutative and `normalizeJournal` is a canonical function.

**PROP-JS-02 (Associative):**

```text
joinJournal(joinJournal(A, B), C)
    = joinJournal(A, joinJournal(B, C))
```

The left side is `normalizeJournal(normalizeJournal(events(A) ∪ events(B)) ∪
events(C))`; by PROP-JT-01 this equals `normalizeJournal(events(A) ∪ events(B)
∪ events(C))`, which is also the right side.

**PROP-JS-03 (Idempotent):**

```text
joinJournal(A, A) = A
```

because `events(A) ∪ events(A) = events(A)` and normalization is idempotent.

Commutativity and associativity are never described through source snapshots,
candidate sets, causal frontiers, or retained evidence. The proof is set union
plus canonical maximum selection.

---

## 2. Deterministic graph projection

Define:

```text
projectGraph(schema, normalizedJournal)
```

The graph is rebuilt entirely from journal assertions. Synchronization never
invokes a computor.

### 2.1 State selection

For each key:

- no selected state entry → unmaterialized;
- selected `delete` → explicitly unmaterialized;
- selected `add` or `edit` → candidate materialization supplied completely by
  that entry.

### 2.2 Materialization closure

Materialized graph state must remain dependency-closed. Compute the greatest
dependency-closed subset of selected `add`/`edit` assertions:

- if any direct input of `N` is absent or explicitly deleted, do not install
  `N`;
- apply this transitively to its dependants.

Call this state:

```text
closure-suppressed
```

It is not a new journal action and does not create a logical delete event. The
selected state assertion remains in the normalized journal, including its
value. A later re-materialization of the missing input can make `N` installable
again. When `N` reappears, its old proof will normally fail to match the newer
input event, so `N` reappears stale rather than incorrectly up-to-date.

### 2.3 Selected proof assertion

For a selected materialized state event `S`:

- when an applicable freshness event exists, it supplies both `tone` and the
  proof map:
  - `validate` supplies `tone = "up-to-date"` and its proof map;
  - `invalidate` supplies `tone = "potentially-outdated"` and its proof map —
    empty for an explicit invalidation, preserved for a propagated
    invalidation;
- otherwise use `S.storedFreshness` and `S.validInputStateEvents`.

Because propagated staleness is itself journaled, the projected freshness never
restores a propagated-stale node merely because its input later validates: the
node's own stale freshness entry remains selected until a later `validate` entry
for the same subject state event arrives.

### 2.4 Rebuild validity

For every selected and installed node `N`, and every direct input `D`:

```text
valid[D].has(N)
```

exactly when the selected proof assertion for `N` contains:

```text
D -> selectedStateEvent(D).eventId
```

Validity is never transported or merged textually; it is reconstructed from
exact event references.

### 2.5 Derive freshness

A selected installed node is `up-to-date` exactly when:

1. its selected proof assertion says `up-to-date`;
2. every direct input is installed;
3. every direct input is `up-to-date`;
4. every required incoming validity edge was reconstructed.

Otherwise it is `potentially-outdated`. Compute this in dependency order.
Staleness propagates through dependants. A stale node may retain complete
incoming and outgoing validity edges, consistent with the flag-based
inverse-validity specification. Because every stale transition is journaled, the
projected graph always equals the committed runtime graph cache.

### 2.6 No multi-input deletion policy

There is no special rule that direct invalidation with zero/one input becomes
stale while two or more inputs become deleted. With complete materialization
assertions and exact input-event proofs, input-count-based deletion is
unnecessary. When all inputs remain materialized, the selected cached value is
retained and marked stale regardless of input count. Only materialization-closure
failure suppresses the node.

### 2.7 Projected-graph validation

`validateProjectedGraph(schema, normalizedJournal, graph)` runs before
destination publication. It requires:

- one selected semantic key maps to one selected `NodeIdentifier`, and one
  selected `NodeIdentifier` maps to one semantic key; duplicate selected
  identifiers are rejected deterministically;
- every installed identifier has exactly one value record, freshness record,
  timestamp record, and identifier-lookup entry;
- no closure-suppressed or deleted identifier appears in installed graph
  storage;
- every validity endpoint is installed;
- every validity edge is a schema-derived direct input edge;
- every `up-to-date` node has all inputs installed and `up-to-date`;
- every `up-to-date` node has a matching proof for every direct input;
- every stored value is a valid `ComputedValue`;
- every timestamp is valid;
- the rebuilt identifier lookup is bijective.

A validation failure MUST reject the merge, commit nothing, leave the active
replica unchanged, and produce the same rejection regardless of operand order.

**Projected-graph validation test:** two event-ID-distinct selected state
entries for different keys carry the same `NodeIdentifier`. The merge must
reject before cutover, because the lookup bijectivity check fails
deterministically.

---

## 3. Synchronization installation and notifications

Synchronization performs:

```text
validate inputs
validateLogicalSnapshot (each staged snapshot)
join normalized journal entries
project final graph
validateProjectedGraph
compare old local graph with final graph
initialize destination as a physical copy of the frozen local journal layout
  (occurrences, indices, gaps, watermark)
append imported occurrences and carriers after the copied watermark
install atomically
```

It creates no new logical event IDs, no sync creator, and no sync-derived
delete or invalidate event. The destination's physical history is the frozen
local source's history; only its logical journal and projected graph are
replaced by the join result.

### 3.0 Compatibility preconditions

Before `joinJournal`, the two operands MUST satisfy:

```text
left.schemaVersion === right.schemaVersion
left.mergeProtocolVersion === right.mergeProtocolVersion
```

These are mandatory preconditions because projection depends on the schema: the
same joined journal can project a node as stale or closure-suppressed under one
schema and as independently fresh under another. A mismatch produces the same
deterministic rejection in either operand order (`joinJournal` rejects before
any union occurs). The schema identity identifies the actual dependency
semantics, not merely a display label; a schema change that alters dependency
edges, proof envelopes, or value types is a different schema identity.

The installation commit is atomic: the graph-cache mutations, the newly imported
physical occurrences, and the local physical watermark advance together. A
failed installation exposes none of them.

### 3.1 Preserving the local physical cursor domain

The inactive synchronization destination must begin with an exact physical copy
of the frozen local active journal. Before appending remote occurrences or
carriers, copy:

```text
every surviving local physical occurrence
its exact LocalJournalIndex
physical gaps/absences
the local physical watermark
```

Then append:

```text
newly imported logical events
notification carriers
```

at fresh indices strictly greater than the copied watermark, allocated from the
single root-local allocator. The distinction is precise:

```text
Logical state comes from joinJournal.
Local physical history comes from the frozen local source.
```

**Cursor-domain trace:**

```text
L contains E at physical index 10
consumer cursor = 5
remote merge is a logical no-op
```

After cutover, the query over `(5, H]` must still observe `E`, because the
destination preserved `L`'s physical layout including the occurrence of `E` at
index 10 and the watermark.

### 3.2 Physical notification carriers

The public journal API uses local physical cursor positions. Therefore
synchronization must notify existing local cursors about graph-observable
changes. For each semantic key whose observable graph state changes relative to
the pre-sync local graph:

- if synchronization already appends a newly imported canonical event for that
  key, that occurrence supplies coverage;
- otherwise append a duplicate occurrence of one of the key's current canonical
  entries at a fresh local physical index.

This duplicate is a notification carrier:

- same `eventId`;
- same immutable payload;
- no new logical event;
- no new logical revision;
- excluded from logical normalization after event-ID deduplication.

Choose the carrier deterministically:

1. when the canonical state event changed, use the canonical state event;
2. when the canonical freshness event changed, use that freshness event;
3. when only derived freshness, validity, suppression, or reappearance changed,
   use the canonical state event;
4. if no canonical entry exists, no materialized historical node exists and no
   key-specific carrier is possible; treat this as an invariant failure rather
   than fabricating an event.

Append carriers for affected keys in canonical semantic-key order.

Physical occurrence placement is local and is not required to converge across
hosts. The boundary is precise:

```text
logical journal + projected graph:
    commutative and associative

local physical indices and cursor-carrier positions:
    deliberately host-local
```

---

## 4. Normative traces

### A. Concurrent state edits

A and B edit the same key `K` from the same selected state revision `r`. Both
create a new state entry with `logicalRevision = r + 1`. The `eventId`
tie-break selects the same value under both merge orders and both binary
groupings, because `stateOrder` compares `(logicalRevision, eventId)`
deterministically and normalization is a maximum selection.

### B. Edit versus validation of the old state

A edits `K`, creating state event `S2`. B concurrently validates old state `S1`.
The final selected state is determined only among state entries: `S2` has a
greater state revision and wins. B's validation refers to `S1`
(`subjectStateEventId = S1.eventId`), so it is not applicable to `S2` and cannot
validate or overwrite the newer value. The final proof for `S2` is its own
`storedFreshness` and `validInputStateEvents`.

### C. Invalidate versus later validate

A invalidates state `S` (freshness revision `f`). B observes the invalidate and
validates `S`, using freshness revision `f + 1`. B's validate wins by
`freshnessOrder`. The selected proof for `S` is `up-to-date` with B's proof map.

### D. Concurrent invalidate and validate

A invalidates state `S` and B concurrently validates `S`; both use the same next
freshness revision. The `eventId` tie-break selects one deterministically under
every grouping. This is documented LWW, not conservative concurrency detection.

### E. Input value changes

`D` is valid against input state event `A1`. The selected input becomes `A2`
(a state edit). The runtime propagates the change to `D`, marking it stale and
preserving its proofs, and the propagation emits an `invalidate` entry for `D`'s
selected state event with `tone = "potentially-outdated"` and the preserved
proof map. Under projection, `D`'s proof references `A1` while the selected
input is `A2`, so its incoming validity edge is absent and `D` is stale. The
runtime cache and the projection agree. `D` becomes fresh only after its own
`validate` entry for the current state (a pull that revalidates against `A2`).
A physical carrier for `D` provides cursor notification when needed.

### F. Input temporarily deleted and re-added

`D` depends on `A`.

1. `A` is deleted (selected state entry becomes `delete`).
2. `D` is closure-suppressed, but its complete state entry remains in the
   normalized journal with its value and proof.
3. A later state event re-materializes `A`.
4. `D` is installable again.
5. Its proof still references the older `A` event, so it reappears stale.

Both groupings of three snapshots produce identical normalized journals and
identical projected graphs.

### G. Stale input later validates unchanged

`D` retains a validity proof against the current input state event `A1`. The
input is explicitly invalidated, and the runtime propagates staleness to `D`:
an `invalidate` entry for `D`'s selected state event `D1` is emitted with
`tone = "potentially-outdated"` preserving `D`'s proof map. A later `validate`
entry makes the same input state `A1` up-to-date. `D`'s own stale freshness
entry remains selected, so `D` stays stale; it becomes fresh only after its own
`validate` entry for `D1` (cache revalidation, no recomputation), because the
state-event identity did not change and `D` retained its proof.

### G'. Propagated staleness persists across input revalidation

```
A → D
A = up-to-date, state event A1
D = up-to-date, proof references A1
```

1. `A` is explicitly invalidated; runtime marks `A` and `D` stale. The journal
   gains an `invalidate` for `A1` (empty proof) and an `invalidate` for `D1`
   (proof preserved).
2. `A` later validates unchanged; its selected state event remains `A1`.
3. Reprojection: `D`'s selected freshness entry still says
   `potentially-outdated`, so `D` remains stale. The runtime graph cache and the
   projection agree. This is the flag-based behavior: recursively invalidated
   `D` stays stale until `D` itself is pulled and cache-revalidates.

### H. Explicit delete versus closure suppression

An explicit selected `delete` keeps the key unmaterialized until a later state
assertion wins. Closure suppression leaves the materialization assertion in the
journal and the node reappears when closure is restored. The two are distinct
logical states.

### I. Compaction law

For representative `A`, `B`, and `C`:

```text
normalize(normalize(A) ∪ B)
=
normalize(A ∪ B)
```

and:

```text
join(join(A, B), C)
=
join(A, join(B, C))
```

The exact normalized entries and the exact projected graph are identical on
both sides of each equality.

### J. Cursor notification

A cursor exists before synchronization. Synchronization changes only a
dependent's derived freshness; no logical event for the dependent changes. A
duplicate canonical carrier is appended after the cursor. The filtered query for
that dependent returns a possible change.

### K. Reset and migration

Several node entries are emitted in one LevelDB batch with no operation ID and
no host-state version. Failure leaves both the graph cache and the physical
occurrences unchanged.
