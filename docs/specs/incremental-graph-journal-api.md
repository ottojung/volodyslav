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
`BaselinePossibleNodeChange` exposes no coordinate. Both remain nominal and structurally non-constructible through the typed object API; raw indexes and authority metadata are not
ordinary public fields. Internally a non-baseline token contains:

```text
visible payload = { nodeName, bindings, action, time }
position = (JournalIndex, actionOrdinal)
issuedBy = querying receiver's DatabaseFingerprint
issuedAtHighWatermark = fixed snapshot's journalRecordHighWatermark
```

`issuedBy` is not necessarily the record's appender. The ordinal order is add,
edit, delete, invalidate, validate. Baseline is a universal before-all position
and needs no issuer coverage.

The journal-owned global string codec parses and preserves the complete signed token:
version, visible payload, immutable position, issuer, and issuance high-watermark.
`nodeName`, `bindings`, and `time` use their existing canonical project codecs;
`action` uses its canonical closed-action spelling. Decode therefore reconstructs
the same public `PossibleNodeChange`, without consulting a `JournalRecord` which
may no longer exist. Normatively:

```text
stringToPossibleChangeToken(possibleChangeTokenToString(change))
    has exactly change.nodeName, change.bindings, change.action, change.time
    and exactly change's hidden position, issuedBy, issuedAtHighWatermark
```

The format is versioned and uses Ed25519: each durable issuer owns a 32-byte
private signing key which never replicates and a matching 32-byte public
verification key which travels with its coverage lineage. The signature is the canonical 64-byte Ed25519 signature over a
domain-separation prefix and every canonical encoded field. Keys and signatures use unpadded base64url, rejecting
non-canonical encodings. A fingerprint maps to exactly one public key in
supported state. Only the issuer can mint authority; synchronized receivers can verify but cannot
sign as that issuer. Query construction signs each newly returned
`PossibleNodeChange`. `possibleChangeTokenToString` returns the canonical signed
representation already carried by either a newly issued or decoded token; it does
not re-sign a foreign token.

`stringToPossibleChangeToken(string)` is deliberately receiver-independent. It
validates canonical encoding, version, payload shapes, ordinals, coordinates,
and fingerprints, and preserves the signature bytes, but it does not claim
cursor authority and does not verify an issuer key. Malformed or structurally
invalid strings reject there. The receiver-bound
`possibleMaybeChanges({since,...})` verifies the preserved Ed25519 signature
against its `cursorTokenVerificationKeys[issuedBy]` and then checks coverage.
Unknown issuers, missing keys, invalid signatures, or any changed visible/hidden
field reject with `InvalidPossibleChangeCursorError` before scanning. A
legitimate encoded and decoded token retains its complete payload and authority
across restart. Runtime object identity is not authority.

A cursor is an immutable cut in global notification order. It never follows a
logical entry or notification record. A token for `(I,ordinal)` forever means
that coordinate, even if I is absent, the witness is compacted, or another
same-key record is appended. Queries compare coordinates directly and MUST NOT
look up evidence to derive where a cursor is now. Missing positions are ordinary
gaps.

Receiver-independent decoding of a non-baseline token MUST establish all of these
structural conditions:

```text
0 <= actionOrdinal < 5
position.index.appendSequence is uint64
issuedAtHighWatermark.appendSequence is uint64
position.index.appender is a valid DatabaseFingerprint
issuedBy is a valid DatabaseFingerprint
position.index <= issuedAtHighWatermark
signature is a canonical 64-byte Ed25519 signature encoding
```

Integer parsing rejects signs, overflow, alternate non-canonical spellings, and trailing data. Payload decoding validates the exact runtime shapes and canonical encodings required by `NodeName`, `BindingEnvironment`, the action union, and `DateTime`. Baseline has exactly one canonical encoding and carries no
position or issuer metadata. A parseable string which fails any condition has no
authority and raises `InvalidPossibleChangeCursorError`. These conditions make
`P.index <= HA` a checked token invariant rather than an assumption of the
cross-host theorem.

Before interpreting a structurally decoded non-baseline position, the receiver
requires both:

```text
Ed25519Verify(
    cursorTokenVerificationKeys[token.issuedBy],
    token.canonicalSignedBytes,
    token.signature
)
cursorCoverageFrontier[token.issuedBy] >= token.issuedAtHighWatermark
```

Failure rejects; it never clamps, falls back to baseline, numerically reinterprets
the token, or writes/reappends journal state. A disconnected receiver therefore
rejects an out-of-band token until synchronization establishes coverage.

## Fixed-snapshot query

At query start capture one committed snapshot of surviving notification records,
`journalRecordHighWatermark`, and `cursorCoverageFrontier`, then validate `since`.
For each `JournalRecord R`, apply the filter directly to its self-contained
`nodeName` and `bindings`, then project:

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
local fingerprint as issuer, captured high-watermark, and issuer signature, and
exposes the record's semantic address and witness time:

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
