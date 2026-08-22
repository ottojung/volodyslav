# IncrementalGraph journal polling API

`possibleMaybeChanges({since,to})` returns visible `{nodeName,bindings,action,time}` with exact add/edit/delete/invalidate/validate. It hides NodeIdentifier, generation, invalidation mode, `clearsThrough`, and graph state.

`PossibleChangeCursor={filterIdentity,through}` where `through=Map<DatabaseFingerprint,uint64>` is an accounted-prefix claim and `filterIdentity` is the canonical identity of the exact NodeFilter used to produce it. Missing vector coordinates are zero. Tokens port between hosts without adoption or rejection when coordinates exceed host coverage, but reuse with a different filter identity throws `InvalidPossibleChangeCursorError` before polling.

For one snapshot, choose the greatest event per `(author,NodeKey,publicAction)`, keep those above the consumer coordinate and matching the self-contained address filter, order by `(sequence,author)`, and attach cumulative vector cursors. Soft/hard share invalidate. Every public graph event has a non-null exact action; internal reset-observation entries are excluded before this projection; reset add/edit/delete/freshness transitions use ordinary events.

## Durable possible-change token v1 codec (normative)

There is exactly one v1 string for a token value:

```text
tokenString = BASE64URL-NOPAD(UTF-8(canonicalTokenJSON))
```

`BASE64URL-NOPAD` uses the RFC 4648 URL-safe alphabet `A-Z a-z 0-9 - _`
and contains no `=` padding. UTF-8 decoding MUST be strict. After decoding and
validation, re-encoding MUST reproduce the input string byte-for-byte; padded,
non-alphabet, non-UTF-8, or otherwise noncanonical input throws
`InvalidPossibleChangeCursorError`.

`canonicalTokenJSON` is an object with exactly these members in this order:
`change`, `cursor`, `filter`, `v`. It has no insignificant whitespace and is
serialized with JavaScript `JSON.stringify` escaping: property names and
strings use JSON double-quote/backslash/control-character escapes, other
Unicode scalar values are emitted as their UTF-8 characters, and lone UTF-16
surrogates use lowercase `\u` hexadecimal escapes. The version is exactly the
JSON integer `1`; unknown fields and every other version or spelling are
invalid.

`change` has exactly these members in this order: `nodeName`, `bindings`,
`action`, `time`.

* `nodeName` is a JSON string satisfying the normative `NodeName`/`ident`
  grammar.
* `bindings` is a JSON array with one string per positional binding. Each
  string is `BASE64URL-NOPAD(canonicalConstBytes(value))`, using the exact
  production ConstValue codec specified below. This keeps ordered record
  semantics without relying on JSON object member reordering.
* `action` is exactly one of `"add"`, `"edit"`, `"delete"`, `"invalidate"`,
  or `"validate"`.
* `time` is a JSON integer in the `UnixTimestamp` interval
  `[-8640000000000000,8640000000000000]`; booleans, fractions, exponent
  spellings, and negative zero are invalid. Decimal integer spelling is
  canonical (zero is `0`, otherwise optional `-` followed by a nonzero digit
  and digits).

`canonicalConstBytes` is the same injective codec used by `filterIdentity`:

```text
value  = "b0" | "b1"                         # false / true
       | "n" + finiteNumberHex
       | "s" + byteLength ":" UTF8(string)
       | "a" + *(byteLength ":" value)
       | "o" + *(byteLength ":" stringValue
                  byteLength ":" value)
```

Lengths are canonical unsigned decimal ASCII (zero is `0`; no leading zeros)
and count bytes. `finiteNumberHex` is the lowercase ECMAScript binary64 value
written as Python `float.hex()`: normal values use
`[-]0x1.<13 lowercase hex digits>p[+-]digits`, subnormal values use
`[-]0x0.<13 lowercase hex digits>p-1022`, and zero is uniquely `0x0.0p+0`.
The exponent has no leading zeros. Implementations may compute these bytes by
any equivalent binary64 algorithm. Integer and floating source values denoting the
same JavaScript Number therefore encode identically, and `-0` canonicalizes to
`+0`. Arrays preserve position. Records emit key/value pairs in insertion order,
so swapping keys changes the bytes as required by `isEqual`. Strings are strict
UTF-8. The decoder must consume exactly one complete value and reject malformed
lengths/tags, duplicate record keys, non-string keys, `null`, non-finite
numbers, and trailing bytes. This is precisely the recursive finite-number,
string, boolean, array, ordered-record `ConstValue` domain; it is not a second
value domain.

`cursor` is a JSON array of entries `[fingerprint, coordinate]`. `fingerprint`
is exactly `/^[a-z]{16}$/`. `coordinate` is a JSON **string** containing a
canonical unsigned decimal integer in `[0,18446744073709551615]` (zero is
`"0"`; otherwise it begins with `1`–`9`). Decimal strings preserve every uint64
value losslessly in JavaScript. Entries are strictly ascending by fingerprint;
duplicates and unsorted entries are invalid. Zero entries are retained rather
than omitted; for a given vector, its canonical token includes exactly the
entries present in that vector, while an absent map coordinate still means
zero.

`filter` is the already-canonical opaque `filterIdentity` string. The decoder
validates that it is the canonical unpadded base64url representation of one
complete filter byte value from `incremental-graph-node-filter.md`; it never
reconstructs a public filter from it. Polling separately recomputes
`filterIdentity(to)` and rejects a mismatch before scanning.

The fixture `scripts/fixtures/possible-change-token-v1.json` is normative
executable evidence for this grammar. Any field, byte, number, ordering, or
encoding not admitted above is invalid. Thus “noncanonical token” is
mechanically decidable by strict parse, validation, and exact re-encoding.

Filtered polling retains its deliberate limitation: no match exposes no continuation and no scan cursor is introduced. Same-filter continuation is exact. A token from a filtered-out lower event followed by a higher match may advance past that lower event only for that identical filter; changing or broadening the filter is an explicit cursor/filter mismatch, never a silent skip.

**No-Action-Specific-False-Negatives.** Compaction retains a same-coordinate representative at least as new as every deleted public event, so virtual and physical polling agree for an unseen cursor/filter obligation. Reset stabilizing validate may be conservative extra notification; real reset transitions cannot be missing.

**Cursor Portability.** Cursor meaning is consumer-global per author within its canonical filter identity and does not depend on receiver coverage.
