# Delta Computing for `all_events`

## Status

This document proposes a replacement for the current "`all_events` first, then
derive everything from it" strategy.

It is a design document only. No implementation is included in this PR.

## Problem

Today the graph still has a large central bottleneck:

- `all_events` is recomputed as a full snapshot of all entries;
- `sorted_events_descending` sorts that full snapshot;
- `sorted_events_ascending` reverses the full sorted list;
- `/search` iterates the sorted stream, so even search requests can pay for the
  full sort path.

For the current workload this is the wrong trade-off.

### Workload facts

- Typical event count: about 20,000.
- `all_events` changes about once per hour.
- Typical edits:
  - append one event: 93%
  - append multiple events: 6%
  - delete one event from the end: 0.7%
  - mutate multiple events: 0.2%
- Typical reads:
  - fetch last 50 sorted events: 84%
  - fetch one event by id: 8%
  - regex search through all events: 5%
- Correctness must stay exact.

The key observation is that the common write is tiny, while the current read
path keeps paying for whole-log recomputation.

## Goals

The target design SHOULD:

1. make single-event appends cheap;
2. keep exact semantics for deletion and mutation;
3. make "last 50 events" avoid full sorting;
4. make "get one event by id" avoid scanning;
5. let consumers resume from a cursor when that is useful;
6. degrade gracefully when rare complex edits happen.

## Evaluation Criteria

Each candidate is evaluated by:

- **exactness** — no approximation, no lossy indexing;
- **common-path speed** — especially append-heavy updates;
- **read latency** — especially last-50 and get-by-id;
- **operational reliability** — easy to repair and reason about;
- **bounded replay cost** — large histories must not require unbounded replay.

## Candidate Set

### Adjacent possibilities

These stay close to the proposed `events_delta` idea.

#### A1. `events_delta` as a computed diff between old `all_events` and new `all_events`

**Idea:** keep `all_events` as the source of truth and derive a monotonic edit
list by comparing two snapshots.

**Pros**

- Small conceptual change to the graph model.
- Consumers can store `events_delta_height`.

**Cons**

- Deriving the diff is still the hard part.
- If the diff requires reading and comparing most of 20,000 events, the main
  win disappears.
- Rare mutations force expensive matching logic.

**Verdict:** reject. This does not solve the expensive part; it moves it.

#### A2. `events_delta` emitted directly by the write path

**Idea:** every storage mutation emits exact operations such as
`append(event)`, `delete(id)`, and `replace(id, event)`.

**Pros**

- Delta creation is cheap because it happens where the mutation already knows
  what changed.
- Consumers can resume from a cursor exactly.
- Perfect fit for append-dominant writes.

**Cons**

- A forever-growing log eventually becomes expensive to replay from zero.
- Consumers still need a materialized state representation for fast reads.

**Verdict:** good primitive, but not sufficient alone.

#### A3. `events_delta` plus periodic checkpoints

**Idea:** keep the monotonic operation log, but also persist checkpoints such as
"state after height 10,000".

**Pros**

- Keeps cursor semantics.
- Bounds replay time.
- Makes recovery straightforward.

**Cons**

- Still does not by itself answer "what should the fast read shape be?"

**Verdict:** strong supporting mechanism, but not the whole design.

### Orthogonal possibilities

These do not depend on a single append-only delta log being the central idea.

#### O1. Exact key-value event store by id

Store each event under its id and stop treating "all events" as the primary
representation.

- `get event by id` becomes O(1)-ish lookup.
- Mutations become overwrite-by-id.
- Deletions become tombstone or remove-by-id.

**Verdict:** clearly desirable, but incomplete without an ordering structure.

#### O2. Write-maintained date index

Maintain an exact secondary index keyed by `(date, id)` and update it on writes.

- Last 50 newest events becomes a short reverse range read.
- Full sorted iteration becomes a range scan, not a rebuild plus sort.
- Appends and deletes are O(log n) per changed event.

**Verdict:** excellent fit for the workload.

#### O3. Small recent-window materialization

Persist a tiny exact cache such as `recent_50` or `recent_100`.

- Directly serves the dominant read.
- Cheap to update on append/delete.
- Can be repaired from the full date index if needed.

**Verdict:** very high leverage and low risk.

#### O4. Streaming scan for regex search

For regex search, iterate the date index and fetch event bodies lazily, instead
of materializing and sorting a full array first.

- Search still costs O(n) in the worst case, which is acceptable for an exact
  regex feature used 5% of the time.
- It removes the unnecessary sort tax from search.

**Verdict:** should be part of the design even without extra indexing.

#### O5. Exact regex candidate index

Maintain a trigram or literal-fragment postings index, but always verify matches
against the original event text.

- Can drastically cut the candidate set for many regexes.
- Keeps exactness because the regex is still run on the true source text.

**Verdict:** promising optional optimization, but not required for the first
design because it is materially more complex than the rest.

#### O6. Persistent ordered tree / B-tree as the canonical representation

Use an ordered persistent structure keyed by `(date, id)` instead of a flat
array.

- Exact sorted iteration becomes native.
- Incremental edits are local.
- Better asymptotics than rebuilding arrays.

**Verdict:** conceptually strong. In practice this is the data-structure form of
O2 and is a good implementation direction for it.

#### O7. External full-text engine

Push search and ordering into SQLite FTS, Lucene, or a similar external engine.

- Potentially fast.
- Operationally much heavier.
- Regex exactness usually still needs verification or fallback scanning.

**Verdict:** too heavy for the current problem. Keep as a distant option only.

## Recommendation

The best design is a **hybrid**:

1. **Write-emitted monotonic operation log** (`events_delta`) for incremental
   consumers and repairability.
2. **Canonical event store by id** for exact direct lookup.
3. **Exact date index** keyed by `(date, id)` for ordered reads.
4. **Tiny recent-window materialization** for the dominant "last 50" path.
5. **Checkpointing** so no component has to replay the entire delta log forever.

In other words: keep the spirit of `events_delta`, but do **not** make a
computed diff-of-snapshots the center of the design. The delta MUST be emitted
at write time, and the fast read path MUST come from maintained materialized
indexes.

## Why this wins

### Compared to the current design

- last-50 no longer needs a full sort;
- get-by-id no longer depends on `all_events`;
- regex search no longer pays the sort cost;
- rare mutations only touch the changed ids and their index entries.

### Compared to `events_delta` alone

- replay is bounded by checkpoints;
- reads do not need to fold the whole log on demand;
- the system stays inspectable because both the operation log and the exact
  materialized views are stored explicitly.

## Proposed Model

### Canonical persisted artifacts

The system SHOULD persist these exact artifacts:

1. **`event_store[id] -> event`**
2. **`date_index[(date, id)] -> present`**, where the value is only a presence
   marker and the ordered key itself is the useful payload
3. **`recent_window`** containing the newest `K` full events, where `K >= 50`
4. **`events_delta`** as a monotonic sequence of operations with heights
5. **periodic checkpoints** of the three read-side artifacts above

### Delta operations

The operation vocabulary SHOULD be small and exact:

- `append(event)`
- `delete(id, previousDate)`
- `replace(id, oldDate, newEvent)`

The delete and replace forms carry enough information to update the date index
without first scanning for the previous record.

## Common Operations Under the Recommended Design

### Append one event

1. append one `events_delta` record;
2. insert event into `event_store`;
3. insert `(date, id)` into `date_index`;
4. update `recent_window`.

This is O(log n) or better, and touches only one event.

### Append many events

Do the same work in a batch. The cost is O(k log n) for `k` appended events,
with good constant factors.

### Delete one event from the end

1. append a delete op;
2. remove from `event_store`;
3. remove one index key from `date_index`;
4. repair `recent_window` from nearby index entries.

### Mutate multiple entries

For each changed id:

1. append a replace op;
2. overwrite `event_store[id]`;
3. if the date changed, move its key in `date_index`;
4. if it falls inside the recent window, refresh that window.

Rare complex edits stay exact, and the rare path is allowed to cost more.

## Read Paths Under the Recommended Design

### Fetch last 50 sorted events

Read directly from `recent_window`, or rebuild it from the tail of `date_index`
plus `event_store` if the window is absent or being repaired.

### Fetch a particular event

Lookup in `event_store` by id.

### Regex search

Scan `date_index` in the requested order and fetch each event lazily from
`event_store`. Optionally add the exact verified candidate index from O5 later.

This keeps correctness exact while removing the sort bottleneck.

## Reliability Notes

- The operation log is valuable for audit, repair, and consumer cursors.
- The materialized indexes are valuable for fast reads.
- Checkpoints keep recovery bounded.
- If an index is ever suspected to be corrupt, it can be rebuilt exactly from
  the latest checkpoint plus the suffix of `events_delta`.

## Final Decision

The project SHOULD adopt **write-path delta emission plus exact materialized
indexes**, not `all_events` snapshot diffing.

More concretely:

- **yes** to `events_delta`, but only if it is emitted at the moment of write;
- **yes** to `events_delta_height` cursors for incremental consumers;
- **yes** to checkpoints;
- **yes** to replacing "`all_events` is the central root for everything" with
  query-shaped exact persisted structures;
- **no** to computing the delta by diffing whole snapshots after the fact.

That combination is the most reliable way to make the common path much faster
while preserving exact correctness.
