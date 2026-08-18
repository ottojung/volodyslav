# IncrementalGraph journal polling API

`graph.possibleMaybeChanges({since,to})` returns visible `{nodeName,bindings,action,time}` where action is add/edit/delete/invalidate/validate. It never exposes NodeIdentifier, generation, invalidate mode, or causal context.

```text
PossibleChangeCursor = Map<DatabaseFingerprint,uint64>
publicAction(E) = E.publicAction if E.kind=generation; otherwise E.action
```

Missing cursor coordinates are zero. `cursor[A]=n` means the consumer accounted for A obligations through n; it is not host coverage. Structurally valid cursors are receiver-independent, accepted above/below host coverage, and may skip the caller's work if fabricated.

## Canonical token

The opaque versioned string contains the visible payload and full hidden vector. Coordinates sort by fingerprint. Decode rejects booleans as integers, values outside uint64, malformed 16-lowercase-letter fingerprints, invalid UnixTimestamp-domain values, malformed payload/address fields, duplicate/unsorted coordinates, unknown fields/version, and non-canonical bytes. Tokens are O(r) application state.

## Snapshot algorithm

For a fixed snapshot:

1. discard entries with `publicAction(E)=null`;
2. choose the greatest-sequence E for each `(E.author,E.key,publicAction(E))`;
3. retain E iff `E.sequence > since[E.author]` and E's self-contained address matches `to`;
4. order by `(sequence,author)`;
5. return E's exact public action/time and attach a cumulative vector updating only E.author.

Soft/hard share visible invalidate. Internal generation fences invent no add/edit. A first materialization exposes its generation add plus its exact initial validate/invalidate; unequal reset generation exposes edit; equal-value fence is invisible except for its initial freshness assertion.

No separate scan cursor exists. If filtering returns nothing, no continuation is exposed.

## Named polling theorems

**Polling No-False-Negatives Theorem** (precise entry/public-coordinate/cursor domain): if unseen E has non-null action and compaction deletes it, retained same-coordinate W has `W.sequence>=E.sequence`, hence remains unseen and filter-equivalent. Therefore virtual polling agrees before/after physical compaction.

**Cursor Portability Theorem** (consumer cursor/host coverage domain): a vector cursor moves unchanged between hosts. `{A:10,B:3}` on coverage `{A:7,B:100}` skips later-arriving A8..A10 and leaves B4..B100 eligible. The host does not adopt or reject its coordinates.

Cumulative vectors make stopping after any returned prefix safe for the same filter. Visible polling is conservative history and cannot by itself reconstruct current NodeKey presence/freshness or NodeIdentifier incarnations.
