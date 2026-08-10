# Possible-change journal API

```text
graph.possibleMaybeChanges({ since, to })
graph.baselinePossibleNodeChange()
PossibleNodeChange = visible change payload + private cursor snapshot
BaselinePossibleNodeChange = private baseline cursor snapshot
InvalidPossibleChangeCursorError
isInvalidPossibleChangeCursorError(object)
```

A returned result means that, after the supplied receiver-local cursor, this
receiver acquired or re-established conservative evidence requiring the stated
closed-classifier action to be considered possible for the semantic key.
"After the cursor" refers only to receiver-local observation/relevance order. It
does not imply that `PossibleNodeChange.time` is later than when the cursor was
issued: a cursor is not a wall-clock timestamp. False positives and collapse
into a later covering possibility are allowed; action-specific false negatives
are forbidden.

`possibleMaybeChanges()` eagerly materializes the complete matching result for
its fixed query snapshot and resolves to
`Promise<Array<PossibleNodeChange>>`. It is not an `AsyncIterable` or
`AsyncIterator` API. The implementation retains one committed active snapshot,
captures its watermark, identifies and expands qualifying entries through that
watermark, filters them, constructs immutable nominal tokens, and returns the
complete deterministically ordered array. A large requested range may therefore
produce a large eager array; this API does not add streaming or pagination.

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
  readonly [possibleNodeChangeCursorBrand]: never; // nominal typing only
}

interface BaselinePossibleNodeChange {
  readonly [possibleNodeChangeCursorBrand]: never; // nominal typing only
}
```

The declarations are conceptual, not a mandated compile-time encoding. The
private `unique symbol` is only a TypeScript nominal brand; it MUST NOT carry the
runtime snapshot as a symbol-keyed property on the public object. Symbol-keyed
properties are reflectable through `Object.getOwnPropertySymbols()`, so an
unexported symbol binding alone does not provide runtime opacity.

The actual cursor snapshot MUST instead reside in genuinely private runtime
state: for example, a module-private `WeakMap<object, CursorSnapshot>`,
inaccessible class-private state with non-public construction, or another
mechanism providing equivalent runtime opacity. Both possible-change and
baseline tokens use this private-token-store principle. Conceptually:

```text
privateCursorSnapshots: WeakMap<object, CursorSnapshot>

construct token:
    token = public readonly payload object
    privateCursorSnapshots.set(token, immutable snapshot)

consume token:
    snapshot = privateCursorSnapshots.get(token)
    if snapshot is absent:
        reject InvalidPossibleChangeCursorError
    if snapshot.cursorDomainIdentity != receiver.cursorDomainIdentity:
        reject InvalidPossibleChangeCursorError
```

The token object itself exposes no snapshot coordinates. Callers can receive,
replay, and pass a legitimate token back unchanged, while only runtime code can
recover its registered snapshot. The brand symbol, domain identity, numeric
index, and ordinal MUST NOT be exported or otherwise exposed to ordinary
callers.

These mechanisms provide independent guarantees. At the TypeScript boundary,
normal external code cannot structurally fabricate either nominal token type.
In particular `{ nodeName, bindings, action, time }` does not type-check as
`PossibleNodeChange` because it lacks the inaccessible nominal component, and no
visible object literal type-checks as `BaselinePossibleNodeChange`. At runtime,
JavaScript objects, `any`, casts, stale objects, and clones have no cursor
authority unless the exact object is registered in private runtime state.

Implementation verification MUST include negative compile-time cases for both
structural forgeries and runtime tests proving all of the following:

1. a plain structural object is rejected;
2. an object supplied through a cast or `any` is rejected;
3. a clone of a real token without its private runtime registration is rejected;
4. inspecting every ordinary own property name and symbol of a real token does
   not reveal its cursor domain, index, or ordinal;
5. foreign real tokens, including foreign baselines, are rejected;
6. an original legitimate token remains valid; and
7. touching its stored witness does not change its captured position.

Tests MUST also retain same-process cutover continuity and new-runtime rejection.

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

Consequently, `PossibleNodeChange.time` may precede cursor issuance. This is
expected when old remote history is newly imported, a known witness is touched
later, or compaction moves notification coverage to a survivor. Cursor order is
receiver-local observation/relevance order, while `PossibleNodeChange.time`
remains the underlying logical `JournalEntry.time`; it is not a receiver-local
delivery or transition time.

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

An unknown-history trace makes the two orders explicit:

```text
t1:
    A authors add E for K
    E.time = t1

t2:
    B issues cursor C
    B does not know E

t3:
    B synchronizes and first stores E
    E receives new receiver-local localIndex > C

query B since C:
    returns conservative PossibleNodeChange(action="add", time=t1)
```

The result is after C in B's receiver-local cursor order. Its time remains t1
because that field records the underlying logical event, not B's later
observation/import time. There is no contradiction between those facts.

A touch likewise moves only receiver-local relevance:

```text
E.time = t1
E.localIndex = 40

cursor C issued after 40

later transaction touches E:
    E.localIndex = 90
    E.time remains t1

query since C:
    may return PossibleNodeChange(..., time=t1)
```

Here 90 answers "when did this evidence become newly relevant to this
receiver?" and t1 answers "when did the underlying logical journal event
occur?" The public API exposes only logical `time`; private cursor authority
contains the receiver-local index. The issued C remains immutable, and no
receiver-local wall timestamp is exposed.

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
