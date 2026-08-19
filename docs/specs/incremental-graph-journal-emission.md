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

Controlled reset may author a stabilizing validation while already visibly fresh because it genuinely observes both snapshots. This is a conservative public validate, not fictitious combination. For soft target it may atomically author joint validation followed by a new soft invalidate. Imported hard barriers are enforced silently.

All event occurrence times follow the timestamp table in the types specification. Allocation is lazy and every transaction atomically commits graph, journal, coverage, clock, identifiers, timestamps, and proofs.
