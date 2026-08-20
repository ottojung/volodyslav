# IncrementalGraph journal polling API

`possibleMaybeChanges({since,to})` returns visible `{nodeName,bindings,action,time}` with exact add/edit/delete/invalidate/validate. It hides NodeIdentifier, generation, invalidation mode, `clearsThrough`, and graph state.

`PossibleChangeCursor={filterIdentity,through}` where `through=Map<DatabaseFingerprint,uint64>` is an accounted-prefix claim and `filterIdentity` is the canonical identity of the exact NodeFilter used to produce it. Missing vector coordinates are zero. Tokens port between hosts without adoption or rejection when coordinates exceed host coverage, but reuse with a different filter identity is rejected before polling.

For one snapshot, choose the greatest event per `(author,NodeKey,publicAction)`, keep those above the consumer coordinate and matching the self-contained address filter, order by `(sequence,author)`, and attach cumulative vector cursors. Soft/hard share invalidate. Every public graph event has a non-null exact action; internal reset-observation entries are excluded before this projection; reset add/edit/delete/freshness transitions use ordinary events.

The versioned canonical string contains visible payload, full hidden sorted vector, and canonical filter identity. The filter identity covers the complete normalized NodeFilter shape/address semantics; equal filters produce identical identity and broadened/narrowed/different filters do not. Decode rejects booleans/numbers outside uint64, malformed fingerprints, invalid UnixTimestamp values, malformed semantic addresses/payloads, duplicate/unsorted coordinates, unknown fields/version, and noncanonical bytes.

Filtered polling retains its deliberate limitation: no match exposes no continuation and no scan cursor is introduced. Same-filter continuation is exact. A token from a filtered-out lower event followed by a higher match may advance past that lower event only for that identical filter; changing or broadening the filter is an explicit cursor/filter mismatch, never a silent skip.

**No-Action-Specific-False-Negatives.** Compaction retains a same-coordinate representative at least as new as every deleted public event, so virtual and physical polling agree for an unseen cursor/filter obligation. Reset stabilizing validate may be conservative extra notification; real reset transitions cannot be missing.

**Cursor Portability.** Cursor meaning is consumer-global per author within its canonical filter identity and does not depend on receiver coverage.
