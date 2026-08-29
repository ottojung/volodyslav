# IncrementalGraph journal polling API

## Public token types (normative)

`PossibleNodeChange` is an opaque nominal public value. Its visible readonly
fields are equivalent to:

```ts
{
    nodeName: NodeName;
    bindings: readonly ConstValue[];
    action: "add" | "edit" | "delete" | "invalidate" | "validate";
    time: UnixTimestamp;
}
```

It also carries immutable implementation-private cursor state containing the
information required for same-filter continuation, including the canonical
filter identity and per-writer cursor vector. This state is not an ordinary
public object field and its runtime representation is implementation-private.
It does not expose raw `JournalEntryId`, generation, invalidation mode, or causal
journal internals. The nominal brand is module-private and unexported, so
TypeScript callers cannot manufacture a `PossibleNodeChange` structurally.

`BaselinePossibleNodeChange` is a distinct opaque nominal type. It is the
filter-independent universal before-all/all-zero polling sentinel, created by
`graph.baselinePossibleNodeChange()`. It is not serializable by the durable
`PossibleNodeChange` codec.

The public manufacturing boundary is exactly:

```text
graph.baselinePossibleNodeChange()
    -> BaselinePossibleNodeChange

graph.possibleMaybeChanges(...)
    -> PossibleNodeChange values

stringToPossibleChangeToken(...)
    -> PossibleNodeChange after complete structural/canonical validation
```

The decoder establishes a syntactically valid nominal `PossibleNodeChange`; it
does not establish that a graph issued the cursor. The guarantees for fabricated
or modified cursor coordinates and issuance history are specified with the codec
below.

The complete polling signature is:

```ts
possibleMaybeChanges({
    since,
    to,
}: {
    since: PossibleNodeChange | BaselinePossibleNodeChange;
    to: NodeFilter;
}): Promise<Array<PossibleNodeChange>>;
```

The promise resolves with a fully materialized ordinary in-memory array, not an
async iterator.

```text
PossibleNodeChange
    public: nodeName, bindings, action, time
    private: filter identity + vector cursor

BaselinePossibleNodeChange
    opaque universal before-all sentinel

JournalEntry / JournalEntryId / generation / causal frontier
    internal journal concepts, not public polling values
```

The private cursor state records the per-author resume position from which
polling continues and the canonical identity of the exact `NodeFilter` used to
produce it. Missing vector coordinates are zero. Coordinates beyond receiver
coverage neither require adoption nor cause rejection. Portability additionally
requires each fingerprint coordinate to denote the same durable writer history
in the token's origin and receiving journal contexts. Reuse with a different
filter identity throws `InvalidPossibleChangeCursorError` before polling.

For one snapshot, choose the greatest event per `(author,NodeKey,publicAction)`, keep those above the consumer coordinate and matching the self-contained address filter, order by `(sequence,author)`, and attach cumulative vector cursors. Soft/hard share invalidate. Every public graph event has a non-null exact action; internal reset-observation entries are excluded before this projection; reset add/edit/delete/freshness transitions use ordinary events.

## Durable possible-change token v1 codec (normative)

Durable v1 conversion applies only to non-baseline `PossibleNodeChange` values:

```ts
possibleChangeTokenToString(token: PossibleNodeChange): string
stringToPossibleChangeToken(tokenString: string): PossibleNodeChange
```

`BaselinePossibleNodeChange` is deliberately not serializable. It is the
filter-independent universal before-all sentinel and callers recreate it with
`graph.baselinePossibleNodeChange()`. Passing it to the encoder is outside the
encoder's input type, and the decoder never returns it. In particular, an empty
cursor plus a fabricated visible change is not a baseline encoding.

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

The decoder performs parsing, structural validation, and canonical-format validation only. The canonical JSON is plainly inspectable and may be constructed or modified by a caller; decoding it does not prove that the graph previously issued it. If a caller supplies fabricated or modified cursor coordinates, polling uses those coordinates as the requested resume position. Changes at or below those coordinates may therefore be skipped, and the no-false-negatives guarantee does not apply to that caller-supplied position.

Cursor coordinates identify writer histories only through
`DatabaseFingerprint`. Durable v1 carries no hostname, branch identity, or
provenance. If independently created writer histories collide on a fingerprint,
moving a cursor from one history to the other can skip changes at coordinates
the receiver interprets as already consumed. The decoder cannot detect this
from a v1 token. Portability and no-false-negatives therefore require every
fingerprint coordinate to denote the same durable writer history in the token's
origin context and the receiving graph's journal context.

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

`cursor` is a non-empty JSON array of entries `[fingerprint, coordinate]`.
Every returned `PossibleNodeChange` has consumed at least its event's positive
author coordinate; therefore an empty cursor is invalid in durable v1. `fingerprint`
is exactly `/^[a-z]{16}$/`. `coordinate` is a JSON **string** containing a
canonical positive decimal integer string: its first digit is nonzero and all
remaining characters are decimal digits. Coordinates are arbitrary precision;
the decoder constructs JavaScript `BigInt` values directly and never passes
through JavaScript `Number`. Entries are
strictly ascending by fingerprint; duplicates, unsorted entries, and explicit
zero coordinates are invalid. Missing coordinates mean zero and the encoder
omits zero coordinates. The all-zero vector belongs only to the non-serializable
`BaselinePossibleNodeChange`.

`filter` is the already-canonical opaque JSON `filterIdentity` string. The
decoder parses and validates its nested JSON before reconstructing the outer
token object:

```js
const filterIdentityValue = JSON.parse(parsed.filter);

validateNormalizedFilterIdentityValue(filterIdentityValue);

if (JSON.stringify(filterIdentityValue) !== parsed.filter) {
    throw InvalidPossibleChangeCursorError;
}
```

`validateNormalizedFilterIdentityValue` accepts only the normalized identity
JSON grammar owned by `incremental-graph-node-filter.md`. In particular, every
union identity value must already have its children in the exact normative
order specified there. The inner exact re-encoding check rejects whitespace,
noncanonical escapes, noncanonical property order, and every other alternate
JSON spelling of the same identity value. The verified `parsed.filter` string
is then placed unchanged in the reconstructed outer token object before the
outer exact re-encoding check. The decoder never reconstructs a public filter
from this metadata. Polling separately recomputes `filterIdentity(to)` and
rejects a mismatch before scanning.

Any field, byte, number, ordering, or encoding not admitted above is invalid.
Thus “noncanonical token” is mechanically decidable by strict parse, validation,
reconstruction, and exact re-encoding with ordinary JavaScript `JSON.stringify`.

Filtered polling retains its deliberate limitation: no match exposes no continuation and no scan cursor is introduced. Same-filter continuation is exact. A token from a filtered-out lower event followed by a higher match may advance past that lower event only for that identical filter; changing or broadening the filter is an explicit cursor/filter mismatch, never a silent skip.

**No-Action-Specific-False-Negatives.** Compaction retains a same-coordinate representative at least as new as every deleted public event, so virtual and physical polling agree for an unseen cursor/filter obligation. Reset stabilizing validate may be conservative extra notification; real reset transitions cannot be missing.

**Cursor Portability.** Cursor meaning is consumer-global per fingerprint
coordinate within its canonical filter identity and does not depend on receiver
coverage, provided that coordinate denotes the same durable writer history in
the origin and receiver contexts. A fingerprint collision between independent
writers violates this premise, and v1 cannot diagnose it.

The journal's no-false-negatives guarantee applies only when `since` is either
`graph.baselinePossibleNodeChange()` or a `PossibleNodeChange` actually returned
by `possibleMaybeChanges()`, optionally round-tripped without modification
through `possibleChangeTokenToString()` and `stringToPossibleChangeToken()`, and
every fingerprint coordinate still denotes the same durable writer history in
the issuing and receiving journal contexts.
