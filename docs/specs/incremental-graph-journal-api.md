# IncrementalGraph journal polling API

`possibleMaybeChanges({since,to})` returns visible `{nodeName,bindings,action,time}` with exact add/edit/delete/invalidate/validate. It hides NodeIdentifier, generation, invalidation mode, `clearsThrough`, and graph state.

`PossibleChangeCursor=Map<DatabaseFingerprint,uint64>` is an accounted-prefix claim, independent of host `journalCoverage`. Missing is zero. Tokens port between hosts without adoption or rejection when cursor coordinates exceed host coverage.

For one snapshot, choose the greatest event per `(author,NodeKey,publicAction)`, keep those above the consumer coordinate and matching the self-contained address filter, order by `(sequence,author)`, and attach cumulative vector cursors. Soft/hard share invalidate. Every event has a non-null exact action; reset add/edit/delete/freshness transitions use ordinary events.

The versioned canonical string contains visible payload plus full hidden sorted vector. Decode rejects booleans/numbers outside uint64, malformed fingerprints, invalid UnixTimestamp values, malformed semantic addresses/payloads, duplicate/unsorted coordinates, unknown fields/version, and noncanonical bytes.

Filtered polling retains its deliberate limitation: no match exposes no continuation; no scan cursor is introduced.

**No-Action-Specific-False-Negatives.** Compaction retains a same-coordinate representative at least as new as every deleted public event, so virtual and physical polling agree for an unseen cursor/filter obligation. Reset stabilizing validate may be conservative extra notification; real reset transitions cannot be missing.

**Cursor Portability.** Cursor meaning is consumer-global per author and does not depend on receiver coverage.
