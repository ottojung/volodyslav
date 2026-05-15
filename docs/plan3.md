# Plan 3: Expand the Populated Incremental-Database Remote Fixture + Add Smoke Tests

## Scope and constraints

This is a **plan-only** document. Implementation will happen later.

- Do not change production code.
- Do not change fixture contents in this step.
- Do not add tests in this step.
- Later implementation should only add fixture/test code and minimal helper updates.
- Keep tests hermetic and deterministic.
- Avoid all external AI/network calls.

---

## Repository findings (relevant to this plan)

1. The populated fixture currently pre-materializes only:
   - `config`
   - `all_events`
   - `events_count`
   plus metadata/freshness/inputs/timestamps/counters files.
2. Current populated sample has only 3 events, which is too small for:
   - meaningful sort/cache boundary behavior,
   - context relationship confidence,
   - realistic smoke coverage.
3. Existing interface/node tests already establish conventions and helpers we should reuse:
   - `stubPopulatedIncrementalDatabaseRemote` / `stubIncrementalDatabaseRemoteBranches`
   - `getMockedRootCapabilities` + stubs (`stubEnvironment`, `stubLogger`, `stubDatetime`, `ensureLiveDatabaseDirectory`)
   - iterator collection and sorted-order assertions from `sorted_events_test_helpers.js`
   - direct node pulls via `iface._incrementalGraph.pull(...)` where needed.
4. `SORTED_EVENTS_CACHE_SIZE` is currently `100`; we should use this constant rather than hardcoding.

---

## Goal 1 plan: richer populated fixture data

## Target dataset size

Use **~24 events** (recommended: exactly 24).

Why 24:
- Large enough for meaningful sorting/context/update behavior.
- Small enough that checked-in rendered JSON stays reviewable.
- Avoids huge fixture diffs.
- Does not cross `SORTED_EVENTS_CACHE_SIZE` (100), which keeps fixture compact. Cache-boundary behavior beyond 100 is already covered by dedicated unit tests.

## Proposed event design

Use stable, explicit IDs with readable prefixes (instead of random IDs), e.g.:
- `fx-2025-01-05-morning-routine`
- `fx-2025-01-05-lunch`
- `fx-2025-01-06-work-deep`
- ...

Recommended structure:
- **Date range**: ~4 months (e.g., 2025-01 to 2025-04).
- **Intentional insertion order mismatch**: store events in non-chronological order inside `all_events.events` so sort nodes must do real work.
- **Same-day clusters**: multiple events on the same day with different times.
- **Shared hashtag groups** for context tests (examples):
  - `#focus` appears in 5–6 events across different days.
  - `#health` appears in 4–5 events.
  - `#project-x` appears in 3–4 events.
- **No-hashtag events**: at least 3 events with plain text/no hashtags.
- **Varied textual content**:
  - short note,
  - longer descriptive diary-like text,
  - mixed punctuation,
  - duplicated keyword but different hashtag set.
- **Lookup-friendly IDs**:
  - pick 2–3 “anchor IDs” specifically referenced by smoke tests.

## Example anchor records (to include exactly)

Include these as stable smoke anchors:
- `fx-anchor-focus-a` at `2025-02-03T09:15:00.000Z`, includes `#focus #project-x`.
- `fx-anchor-focus-b` at `2025-02-10T14:40:00.000Z`, includes `#focus` only.
- `fx-anchor-health-a` at `2025-03-01T07:05:00.000Z`, includes `#health`.
- `fx-anchor-no-tags` at `2025-03-05T19:30:00.000Z`, no hashtags.
- `fx-anchor-latest` at `2025-04-20T22:10:00.000Z`, newest timestamp anchor.
- `fx-anchor-earliest` at `2025-01-02T06:45:00.000Z`, oldest timestamp anchor.

(These IDs/dates are proposed to make assertions crisp and deterministic.)

## Config payload plan

Keep config stable and human-readable. Extend existing shortcut list moderately:
- preserve current 6 shortcuts,
- add 3–4 additional shortcuts used by fixture text patterns,
- keep `help` text stable and smoke-assertable.

Do **not** include volatile fields or environment-dependent values.

## Which graph nodes to pre-materialize in the populated fixture

### Keep pre-materialized
- `all_events`
- `config`
- `events_count`
- required metadata/freshness/inputs/timestamps/counters for those keys.

### Intentionally **not** pre-materialized (computed in smoke tests)
- `event(e)`
- `sorted_events_descending`
- `sorted_events_ascending`
- `last_entries(n)`
- `first_entries(n)`
- `basic_context(e)`
- `entry_description(e)`

Reason: smoke suite should prove these are computable/useful from the fixture snapshot, not merely pre-baked.

## Determinism/readability rules for fixture generation (later implementation)

1. Build fixture data from a single deterministic source definition file/object in test code.
2. Use fixed ISO timestamps in UTC (`...Z`).
3. Use stable ID strings (no random generators).
4. Ensure serialized event order in `all_events` is deliberately non-sorted but fixed.
5. Keep creator metadata consistent and pinned (including version string policy below).

## Version pinning recommendation

Use a pinned fixture creator version like `0.0.0-dev` (or repository’s chosen fixture pin) consistently for all fixture events and any generated metadata, aligned with migration-fixture conventions. Avoid embedding current git-describe outputs in fixture data.

---

## Goal 2 plan: smoke-test suite for populated fixture

## Proposed new test file

- `backend/tests/populated_incremental_database_remote_smoke.test.js`

## Test setup strategy

Follow existing backend test conventions:
1. Create mocked capabilities via `getMockedRootCapabilities()`.
2. Apply `stubEnvironment`, `stubLogger`, `stubDatetime`, `ensureLiveDatabaseDirectory`.
3. Seed remote using `stubPopulatedIncrementalDatabaseRemote(capabilities)`.
4. Use `capabilities.interface` / `makeInterface(...).ensureInitialized()` as current tests do.
5. Use temp dirs only through existing capabilities; never mutate checked-in fixture dirs.

Optional small helper additions (later):
- local helper `collectAll(iter)` if not imported.
- local helper `expectSortedAscending/Descending(events)`.

## Smoke test cases to add

1. **bootstrap from populated fixture**
   - initialize interface against populated remote
   - assert initialization succeeds and graph is accessible
   - if reset path is relevant in this repo flow, include one explicit `synchronizeDatabase({ resetToHostname: ... })` assertion.

2. **getAllEvents returns realistic dataset**
   - assert exact expected count (e.g. 24)
   - assert anchor IDs exist
   - assert representative content snippets exist
   - assert `event.date` values are DateTime objects (not plain strings).

3. **getConfig works**
   - assert `help` equals pinned fixture help text
   - assert selected expected shortcuts exist (not every byte).

4. **getEvent existing/missing**
   - existing anchor ID returns event with expected ID/date/content pattern
   - missing ID returns `null`.

5. **getEventsCount consistency**
   - `getEventsCount()` equals `getAllEvents().length`
   - optionally assert direct node pull `events_count` type+count.

6. **getSortedEvents both orders**
   - collect descending and ascending iterators
   - assert each is correctly sorted by date
   - assert IDs are exact reverse sequences
   - assert async iterator consumption works via `for await`.

7. **direct sorted graph pulls**
   - pull `sorted_events_descending` and `sorted_events_ascending`
   - assert types and consistent reverse relationship.

8. **first/last cache node behavior on fixture snapshot**
   - pull `last_entries(SORTED_EVENTS_CACHE_SIZE)` and `first_entries(...)`
   - because fixture count < cache size, assert these equal full sorted lists respectively
   - assert lengths equal total event count.

9. **update on top of populated fixture**
   - add 1–2 deterministic new events via normal `iface.update([...])`
   - assert count increases accordingly
   - assert old anchor IDs still present
   - assert new ID present and correctly ordered in sorted results
   - assert `getEvent(newId)` returns new event.

10. **basic context for shared hashtags**
    - target `fx-anchor-focus-a` (shared `#focus`)
    - call `getBasicContextForEventId(id)` and/or `getEventBasicContext(event)`
    - assert expected related focus IDs are included
    - assert an unrelated no-hashtag anchor is excluded.

11. **synchronize/reopen preserves data**
    - after bootstrap (and optionally after one update), call `synchronizeDatabase()`
    - re-read config/events/count
    - assert fixture + updates are preserved.

## What not to assert in smoke suite

- Raw rendered file byte-for-byte snapshots.
- Every field of every event.
- AI-related nodes (`calories`, `transcription`, `event_transcription`, diary summary generation) that may require side effects.

---

## Files expected to be changed in later implementation

### Fixture update
- `backend/tests/mock-incremental-database-remote-populated/rendered/r/values/all_events`
- `backend/tests/mock-incremental-database-remote-populated/rendered/r/values/events_count`
- `backend/tests/mock-incremental-database-remote-populated/rendered/r/values/config`
- corresponding freshness/inputs/timestamps/counters files under:
  - `.../rendered/r/freshness/...`
  - `.../rendered/r/inputs/...`
  - `.../rendered/r/timestamps/...`
  - `.../rendered/r/counters/...`
- (only if needed) metadata file consistency checks under `rendered/_meta/current_replica`.

### Tests
- add: `backend/tests/populated_incremental_database_remote_smoke.test.js`
- optionally extend shared helpers if truly beneficial:
  - `backend/tests/sorted_events_test_helpers.js` (minimal additions only).

### Documentation (optional but recommended)
- update `docs/INCREMENTAL_DATABASE_REMOTES.md` fixture content description/count.

---

## Safe process for updating fixture data later

1. Define deterministic fixture dataset in one source location.
2. Use existing rendering/materialization flow to regenerate rendered files.
3. Verify no unexpected extra nodes are materialized.
4. Run focused smoke suite + existing related tests (`sorted`, `events_count`, `database_synchronize`, interface tests).
5. Review fixture diff for readability and intended content only.

---

## Risks and ambiguities identified

1. **Context behavior dependency**: `basic_context` behavior depends on `event_context` implementation details; expected inclusion/exclusion sets must reflect current algorithm (hashtag matching specifics).
2. **Date sorting ties**: equal timestamps may produce unstable expectations unless explicitly avoided or intentionally tested with tie-safe assertions.
3. **Fixture version field policy**: current fixture contains git-describe-like version strings; migration to pinned `0.0.0-dev` may affect assumptions elsewhere.
4. **Interface lifecycle differences** across tests (using `capabilities.interface` vs `makeInterface`) should be normalized in smoke file for consistency.
5. **Over-coupling danger**: asserting too many literal strings can make smoke tests brittle; keep anchor-based assertions focused.

---

## Implementation order (later)

1. Finalize deterministic dataset spec (IDs, dates, text, hashtag groups, config anchors).
2. Regenerate populated fixture rendered snapshot (`all_events`, `events_count`, `config` + metadata files).
3. Add smoke test file with the 11 scenarios above.
4. Add tiny shared helpers only if needed to avoid duplication.
5. Run targeted tests, then full backend tests.
6. Update fixture documentation summary.

