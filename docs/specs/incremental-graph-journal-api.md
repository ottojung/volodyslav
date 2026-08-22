# IncrementalGraph journal polling API

`possibleMaybeChanges({since,to})` returns visible `{nodeName,bindings,action,time}` with exact add/edit/delete/invalidate/validate. It hides NodeIdentifier, generation, invalidation mode, `clearsThrough`, and graph state.

`PossibleChangeCursor={filterIdentity,through}` where `through=Map<DatabaseFingerprint,uint64>` is an accounted-prefix claim and `filterIdentity` is the canonical identity of the exact NodeFilter used to produce it. Missing vector coordinates are zero. Tokens port between hosts without adoption or rejection when coordinates exceed host coverage, but reuse with a different filter identity throws `InvalidPossibleChangeCursorError` before polling.

For one snapshot, choose the greatest event per `(author,NodeKey,publicAction)`, keep those above the consumer coordinate and matching the self-contained address filter, order by `(sequence,author)`, and attach cumulative vector cursors. Soft/hard share invalidate. Every public graph event has a non-null exact action; internal reset-observation entries are excluded before this projection; reset add/edit/delete/freshness transitions use ordinary events.

## Durable possible-change token v1 codec (normative)

There is exactly one v1 string for a token value:

```text
tokenString = JSON.stringify(canonicalTokenObject)
```

`canonicalTokenObject` is an object with exactly these members in this order:
`change`, `cursor`, `filter`, `v`. It has no insignificant whitespace and is
serialized by JavaScript `JSON.stringify`. The version is exactly the JSON
integer `1`; unknown fields and every other version or spelling are invalid.
Decoding performs `JSON.parse`, validates the exact recursive shape,
reconstructs the canonical object, and requires
`JSON.stringify(reconstructed) === tokenString`. Failure at any step throws
`InvalidPossibleChangeCursorError`.

`change` has exactly these members in this order: `nodeName`, `bindings`,
`action`, `time`.

* `nodeName` is a JSON string satisfying the normative `NodeName`/`ident`
  grammar.
* `bindings` is the positional JSON array of actual validated `ConstValue`
  values. There is no nested encoding.
* `action` is exactly one of `"add"`, `"edit"`, `"delete"`, `"invalidate"`,
  or `"validate"`.
* `time` is a JSON integer in the `UnixTimestamp` interval
  `[-8640000000000000,8640000000000000]`; booleans, fractions, exponent
  spellings, and negative zero are invalid. Decimal integer spelling is
  canonical (zero is `0`, otherwise optional `-` followed by a nonzero digit
  and digits).

Bindings use the one value serialization rule: validate as `ConstValue`, then
serialize with `JSON.stringify`. This supplies JavaScript Number formatting,
normalizes `-0` to `0`, preserves array positions, escapes JavaScript strings,
and enumerates record properties in ECMAScript `Object.keys` order. Thus
integer-index-like keys are numeric-first and other string-key order remains
semantic exactly as in DEF-EQUAL-01.

`cursor` is a JSON array of entries `[fingerprint, coordinate]`. `fingerprint`
is exactly `/^[a-z]{16}$/`. `coordinate` is a JSON **string** containing a
canonical unsigned decimal integer in `[1,18446744073709551615]`. Decimal
strings preserve every uint64 value losslessly in JavaScript. Entries are
strictly ascending by fingerprint; duplicates, unsorted entries, and explicit
zero coordinates are invalid. Missing coordinates mean zero, the encoder omits
zero coordinates, and the baseline/all-zero vector is `[]`.

`filter` is the already-canonical opaque JSON `filterIdentity` string. The
decoder validates only the normalized identity JSON grammar owned by
`incremental-graph-node-filter.md`; it never reconstructs a public filter from
it. Polling separately recomputes
`filterIdentity(to)` and rejects a mismatch before scanning.

The fixture `scripts/fixtures/possible-change-token-v1.json` is normative
executable evidence for this grammar. Any field, byte, number, ordering, or
encoding not admitted above is invalid. Thus “noncanonical token” is
mechanically decidable by strict parse, validation, and exact re-encoding.

Filtered polling retains its deliberate limitation: no match exposes no continuation and no scan cursor is introduced. Same-filter continuation is exact. A token from a filtered-out lower event followed by a higher match may advance past that lower event only for that identical filter; changing or broadening the filter is an explicit cursor/filter mismatch, never a silent skip.

**No-Action-Specific-False-Negatives.** Compaction retains a same-coordinate representative at least as new as every deleted public event, so virtual and physical polling agree for an unseen cursor/filter obligation. Reset stabilizing validate may be conservative extra notification; real reset transitions cannot be missing.

**Cursor Portability.** Cursor meaning is consumer-global per author within its canonical filter identity and does not depend on receiver coverage.
