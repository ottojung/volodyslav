# Possible-change journal API

```text
graph.possibleMaybeChanges({ since, to })
graph.baselinePossibleNodeChange()
PossibleNodeChange = visible change payload + private cursor snapshot
BaselinePossibleNodeChange = private baseline cursor snapshot
InvalidPossibleChangeCursorError
isInvalidPossibleChangeCursorError(object)
```

A result means that this exact closed-classifier action may have happened to the
semantic key after the cursor. False positives and collapse into a later
covering possibility are allowed; action-specific false negatives are forbidden.

## Cursor and query

`PossibleNodeChange` and `BaselinePossibleNodeChange` are opaque nominal public
types. Conceptually their public declarations use a module-private brand:

```ts
declare const possibleNodeChangeCursorBrand: unique symbol; // not exported

type PossibleChangeCursorSnapshot = Readonly<{
  cursorDomainIdentity: CursorDomainIdentity;
  localIndex: UInt64;
  actionOrdinal: PossibleActionOrdinal;
}>;

interface PossibleNodeChange {
  readonly nodeName: NodeName;
  readonly bindings: BindingEnvironment;
  readonly action: "add" | "edit" | "delete" | "invalidate" | "validate";
  readonly time: DateTime;
  readonly [possibleNodeChangeCursorBrand]: PossibleChangeCursorSnapshot;
}

interface BaselinePossibleNodeChange {
  readonly [possibleNodeChangeCursorBrand]: BaselineCursorSnapshot;
}
```

The declarations are conceptual, not a mandated runtime representation. A
module-private symbol property, private class field, `WeakMap`, or equivalent
non-forgeable mechanism MAY carry the snapshot. The brand symbol, domain
identity, numeric index, and ordinal MUST NOT be exported or otherwise exposed
to ordinary callers. Callers can receive and pass tokens back, while runtime
code can recover their hidden snapshots.

Consequently normal external TypeScript MUST reject structural fabrication of
either type. In particular `{ nodeName, bindings, action, time }` does not
type-check as `PossibleNodeChange` because it lacks the inaccessible nominal
component, and no visible object literal type-checks as
`BaselinePossibleNodeChange`. JavaScript, `any`, casts, stale objects, and tokens
from other graphs still require runtime validation.

Implementation verification MUST include negative compile-time cases for both
structural forgeries, plus runtime tests for foreign change tokens, foreign
baselines, same-process cutover continuity, new-runtime rejection, and an issued
token retaining its copied index after the stored witness is touched.

The hidden snapshot is conceptually
`(cursorDomainIdentity,localIndex,actionOrdinal)`, where the ordinal uses the
fixed order add, edit, delete, invalidate, validate. It is neither a
`JournalEntryId` nor serializable or user-constructible.
`graph.baselinePossibleNodeChange()` returns an immutable nominal token bound to
its receiver domain, conceptually `(domain,before-all-local-indexes,
before-first-action)`; there is no universal baseline. It is non-serializable,
non-user-constructible, foreign after a new runtime domain is allocated, and
remains valid across supported same-process cutovers that preserve the domain.

Before interpreting either numeric coordinate, `possibleMaybeChanges()` MUST
compare the token's private domain identity with its receiver. A foreign token,
including another receiver's baseline, deterministically rejects with
`InvalidPossibleChangeCursorError`; it is never clamped, numerically
reinterpreted, or treated as baseline. This dedicated public API error is exported with the obvious
`isInvalidPossibleChangeCursorError(object)` `instanceof` type guard. Raw
positions and domain identity are never exposed.

The numeric coordinate captured in a cursor is copied from
`StoredJournalEntry.localIndex`, allocated from the
receiver's `localJournalIndexWatermark`; it is not the replicated
`JournalEntry.sequence` allocated from `localJournalClock`. Sequence travels
with immutable logical history, whereas local index never leaves its receiver
and may move when that receiver touches the entry. The issued cursor snapshot is
immutable and is not the mutable stored entry. A token issued for `(R,51,edit)`
permanently means `(R,51,edit)` even if `touch(E)` moves E from index 51 to 90.
It MUST NOT contain a live reference whose index is consulted later, derive its
position lazily from E, or change when E or another witness is touched.

A query retains one fixed committed active snapshot, captures
`localJournalIndexWatermark=H`, considers stored entries after `since` and at or
before H, expands them, applies `NodeFilter`, and returns deterministic
`(localIndex,actionOrdinal)` order. An implementation may scan the current physical journal; any secondary local index must be reconstructible. Because compaction is optional, cost may depend on uncompacted size.
Cutover cannot straddle snapshot selection.

For each returned record, while holding that snapshot, the query reads the
stored entry's numeric local index, expands its five actions, and captures the
current receiver domain, copied index, and action ordinal into a new immutable
nominal token. `nodeName`, `bindings`, `action`, and `time` are visible payload;
the hidden `(domain,index,ordinal)` snapshot is continuation identity.
`possibleMaybeChanges({since})` interprets only that hidden snapshot and MUST
NOT reconstruct a position from visible payload fields.

For every qualifying stored entry E:

```text
PossibleActions(E) = { add, edit, delete, invalidate, validate }
PossibleNodeChange.time = E.entry.time
```

All five records use E's semantic key and immutable occurrence time. The local
index answers when this possibility became relevant to this receiver; `time`
answers when the underlying journal event occurred in real wall-clock time. It
is the event occurrence time. For add/edit it is necessarily the semantic
value's `modifiedAt`; a reset with an unchanged semantic value emits no value event. There is no receiver-local
event object, action mask, cause field, or transition timestamp.

The action ordinal lets a client advance record-by-record without skipping the
remaining projections at one index:

```text
(51,add), (51,edit), (51,delete), (51,invalidate), (51,validate), (52,add)
```

## Installation and touch traces

* **Unknown history:** B first learns remote entry E. B stores E unchanged and
  assigns a fresh local index; all five possibilities become observable.
* **Known witness touched:** synchronization changes key K using history already
  known by B. B updates only `notificationWitness(K).localIndex`; its logical
  entry remains identical and all five possibilities cover the actual action.
* **Settled no-op:** receiving an already-known entry with no graph or compaction
  change neither touches it nor advances the watermark.

## Cursor-coverage theorem

For every cursor C issued by receiver cursor domain R before a successful
transaction T, and every key K with at least one actual closed-
classifier transition, either T installs/authors an unknown entry for K or it
touches the greatest retained `JournalEntryId` for K,
`notificationWitness(K)`. Do this once per changed key, not once per action. If
an entry for K already receives a fresh index in T, no extra touch is needed.
Graph changes and index updates commit atomically.

For that same-domain cursor C:

```text
C <= oldWatermark < witness.localIndex
```

A later query therefore observes the witness, whose five projections include
the exact action. A later touch only moves coverage forward. If compaction
removes the witness, compaction touches another retained same-key witness above
its old watermark. Induction over transactions proves no action-specific false
negative. Touching one entry a million times retains one logical entry and one
scalar index.

Inactive construction inside the same running receiver copies every retained
local index and watermark from one fixed snapshot and threads that receiver's
runtime-only cursor-domain identity through the construction path. Domain,
entries/indexes, and watermark are published as one in-process cutover state, so
cursors issued before supported synchronization, migration, or reset cutover
remain valid afterward. Remote indexes and identities never participate.

A new process/startup receiver allocates a new identity even when self-restoring
entries, indexes, and watermark from synchronization state. Cursor tokens are
non-serializable and process-local, so no cross-runtime continuity is promised;
if an old token is artificially retained, the new receiver rejects it as
foreign before interpreting its numeric position.

## Deliberate cursor limitations

Computor invocation does not receive a journal cursor, and the runtime exposes no computation-position or bootstrap cursor. This omission is deliberate. `graph.baselinePossibleNodeChange()` means only before all locally observable history in this cursor domain; it is not the position at which a computor began and is not a substitute. No raw `JournalIndex`, `journalGet`, computor context, hidden graph handle, or bootstrap cursor is part of this API.

A filtered query that scans through internal watermark H but returns no matching change produces no reusable cursor. The caller's previous cursor remains its only continuation and later queries may reconsider the same excluded entries. This is intentional. `possibleMaybeChanges()` guarantees conservative change coverage, not amortized filtered scan progress. No `scannedThrough` value and no `O(number of newly unseen matching changes)` guarantee is promised. Reconstructible indexes MAY optimize this without changing cursor semantics. Query cost may depend on uncompacted journal size.
