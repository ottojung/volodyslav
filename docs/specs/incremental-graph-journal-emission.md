# IncrementalGraph journal emission

Ordinary exact classification:

* absent→present: GenerationJournalEntry(add) at value modifiedAt plus exactly one later initial validate/soft-invalidate/hard-invalidate;
* present→absent: delete;
* present X→present Y with `!isEqual(X,Y)`: scoped edit;
* equal present value: no generation/edit;
* fresh establishment/re-establishment: validate with legitimately evidenced `clearsThrough`;
* fresh→stale reusable: soft invalidate;
* newly unrepresented must-recompute: hard invalidate.

For every administrative or ordinary transaction that authors a scoped edit and finishes stale, emission is ordered `edit` then a newly authored negative assertion for that edited value. A reusable target emits a new soft invalidate; a must-recompute target emits a new hard invalidate even when an older same-generation barrier is still uncovered. A validation authored before the edit cannot clear the post-edit assertion. Fresh edited targets follow the ordinary validation/absorption rule, and equal values emit no edit.

Post-edit, initial-cache-status, proof-loss, and propagated-input-staleness invalidates are value-specific and name the value origin they describe. An explicit public/concurrent invalidation intended to revoke freshness independent of value selection is generation-wide. Both forms expose the same exact public `invalidate` action.

Controlled reset may author a stabilizing validation while already visibly fresh because it genuinely observes both snapshots. This is a conservative public validate, not fictitious combination. For soft target it may atomically author joint validation followed by a new soft invalidate. Imported hard barriers are enforced silently.

All event occurrence times follow the timestamp table in the types specification. Allocation is lazy and every transaction atomically commits graph, journal, coverage, clock, identifiers, timestamps, and proofs.

Every authored validate names the exact current value origin. Initial fresh materialization names the generation entry; a fresh same-generation edit receives a distinct validation naming that edit. A validation for an older or losing origin cannot establish freshness for the selected value.
