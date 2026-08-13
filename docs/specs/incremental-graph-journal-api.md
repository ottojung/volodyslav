# Possible-change journal API

```text
graph.possibleMaybeChanges({ since, to })
graph.baselinePossibleNodeChange()
possibleChangeTokenToString(token)
stringToPossibleChangeToken(string)
InvalidPossibleChangeCursorError
isInvalidPossibleChangeCursorError(object)
```

The existing `NodeFilter` (`to`) and eager `Promise<Array<PossibleNodeChange>>`
contract remain unchanged. A result is conservative notification evidence, not
an exact event. False positives and duplicates are allowed; action-specific
false negatives are forbidden.

## Opaque durable cursor tokens

`PossibleNodeChange` exposes only `nodeName`, `bindings`, `action`, and `time`.
`BaselinePossibleNodeChange` exposes no coordinate. Both remain nominal,
non-user-constructible abstractions; raw indexes and authority metadata are not
ordinary public fields. Internally a non-baseline token contains:

```text
position = (JournalIndex, actionOrdinal)
issuedBy = querying receiver's DatabaseFingerprint
issuedAtHighWatermark = fixed snapshot's journalRecordHighWatermark
```

`issuedBy` is not necessarily the record's appender. The ordinal order is add,
edit, delete, invalidate, validate. Baseline is a universal before-all position
and needs no issuer coverage.

The journal-owned string codec is canonical, versioned, validated on decode and
durable across restart. It preserves the exact position, issuer and issuance
high-watermark without exposing them as ordinary token fields. Malformed strings,
plain structural fabrications, clones without authority, and unknown versions
reject with `InvalidPossibleChangeCursorError`; a legitimate encoded and decoded
token retains full authority. Runtime object identity is not authority.

A cursor is an immutable cut in global notification order. It never follows a
logical entry or notification record. A token for `(I,ordinal)` forever means
that coordinate, even if I is absent, the witness is compacted, or another
same-key record is appended. Queries compare coordinates directly and MUST NOT
look up evidence to derive where a cursor is now. Missing positions are ordinary
gaps.

Before interpreting a non-baseline position, the receiver requires:

```text
cursorCoverageFrontier[token.issuedBy] >= token.issuedAtHighWatermark
```

Failure rejects; it never clamps, falls back to baseline, numerically reinterprets
the token, or writes/reappends journal state. A disconnected receiver therefore
rejects an out-of-band token until synchronization establishes coverage.

## Fixed-snapshot query

At query start capture one committed snapshot of surviving notification records,
`journalRecordHighWatermark`, and `cursorCoverageFrontier`, then validate `since`.
For each `JournalRecord R`, project:

```text
(R.index, add)
(R.index, edit)
(R.index, delete)
(R.index, invalidate)
(R.index, validate)
```

Apply `NodeFilter` and return exactly projections greater than `since.position`,
ordered by `JournalIndex` then ordinal. A cursor partway through one record still
sees its later ordinals. Each result privately captures its projection position,
local fingerprint as issuer, and captured high-watermark, and exposes:

```text
nodeName, bindings, action,
time = fromUnixTimestamp(R.time)
```

Visible time is logical witness time, not append or delivery time. It can precede
cursor issuance and can be a later covering witness's time rather than the exact
transition's time. Querying never invokes a computor and never allocates or
acquires a writer allocator. Cutover cannot straddle snapshot selection.

If a filtered query returns nothing it supplies no synthetic scanned-through
cursor; the caller retains its previous cursor. Cost may depend on uncompacted
notification size. No streaming, pagination, `journalGet`, computor bootstrap
cursor, exact-event promise, or raw coordinate API is introduced.

## Positional and cross-host theorems

**Continuation stability.** If a consumer queries from C0, processes through C1
and persists C1, then after supported synchronization, restart, migration and
compaction, C1 means continue strictly after the position actually processed.
It never means continue after the present location of related logical evidence.

**Cross-host cursor theorem.** A token issued by A at position P and watermark HA
has `P.index <= HA`. B may interpret it exactly when `B.frontier[A] >= HA`.
Synchronization establishes this only after conservative coverage: if B's final
same-key state equals A's, imported pending records suffice; if it differs, B
has a same-key record strictly after HA. Compaction can only replace that record
with a later same-key record. Thus tokens port after coverage synchronization,
without cursor-specific adoption or replay. Before it, rejection is deterministic.

**Action no-false-negative theorem.** If record R covered transition T and is
removed, max-per-key compaction retains same-key W with `R.index < W.index` and W
projects every action. For any cursor before R, `C < R < W`; T's action remains
a conservative possibility. W's witness time may differ from T's occurrence.

## Adversarial traces

* **Deleted cursor record:** records `10:A, 20:B, 30:C, 40:D`, cursor 10, then
  `50:A`. Compaction deletes 10; the unchanged cursor returns B, C, D, A.
* **Action ordinal:** since `(10,edit)` returns delete, invalidate and validate
  at 10 before later indexes.
* **Unsynchronized host:** A's token has issuance watermark 100. Disconnected C
  has `frontier[A] < 100`, rejects it, and appends nothing.
* **Restart:** encode a token, restore the same supported durable host state,
  decode it, and continuation is unchanged.

Supported journal-preserving migration/cutover preserves token meaning and does
not renumber records. Rollback to an older checkpoint under the same durable
fingerprint is unsupported.
