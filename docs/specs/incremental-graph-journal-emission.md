# IncrementalGraph journal emission

Ordinary exact classification:

* absent→present: GenerationJournalEntry(add) at value modifiedAt plus exactly one later initial validate/soft-invalidate/hard-invalidate;
* present→absent: delete;
* present X→present Y with `!isEqual(X,Y)`: scoped edit;
* equal present value: no generation/edit;
* fresh establishment/re-establishment: validate with legitimately evidenced `clearsThrough`;
* fresh→stale reusable: soft invalidate;
* newly unrepresented must-recompute: hard invalidate.

For every ordinary computation or controlled reset that authors a scoped edit
and finishes stale, emission is ordered `edit` then a newly authored negative
assertion for that edited value. Migration is not such a path: it cannot
directly replace an already-materialized semantic value. A reusable target
emits a new soft invalidate; a must-recompute target emits a new hard invalidate
even when an older same-generation barrier is still uncovered. A validation
authored before the edit cannot clear the post-edit assertion. Fresh edited
targets follow the ordinary validation/absorption rule, and equal values emit
no edit.

Post-edit, initial-cache-status, proof-loss, and propagated-input-staleness invalidates are value-specific and name the value origin they describe. An explicit public/concurrent invalidation intended to revoke freshness independent of value selection is generation-wide. Both forms expose the same exact public `invalidate` action.

Controlled reset may author a stabilizing validation while already visibly fresh because it genuinely observes both snapshots. This is a conservative public validate, not fictitious combination. For soft target it may atomically author joint validation followed by a new soft invalidate. Imported hard barriers are enforced silently.

All event occurrence times follow the timestamp table in the types specification. Each event takes the next local coordinate and its immutable `causalContext` contains transaction-observed causal authority plus carried-forward local knowledge. Every transaction atomically commits graph, journal, reset-anchor cut summaries, coverage, local counter, causal summary, identifiers, timestamps, and proofs.

Every authored validate names the exact current value origin. Initial fresh materialization names the generation entry; a fresh same-generation edit receives a distinct validation naming that edit. A validation for an older or losing origin cannot establish freshness for the selected value.

Validation applicability remains exact-value-origin scoped, but every new validation componentwise carries the greatest prior same-author/key/generation `clearsThrough` vector across value edits. Reset lineage is emitted on the retained freshness assertion for a present target and on the real delete for a present-to-absent target. An absent-to-absent target authors a no-public-action ResetObservationEntry anchored to the receiver delete or to null explicit absence; an unchanged repeat emits nothing.

Its `absorbsThrough` vector is the closed per-author prefix intentionally consumed. `applicableAnchors(J,K)` is exactly the per-anchor displacement test defined by the journal synchronization specification. Every applicable assertion derives its result using only its own tagged anchor's effective `anchorCut`; concurrent anchors never join cuts during projection. Controlled reset computes each observed anchor cut from its retained carriers plus exact `resetAnchorCuts` summary, then carries the full cuts of the anchors it actually consumes into the new lineage. It also enumerates every source anchor represented by a reset-lineage carrier or cut summary, computes the same exact-anchor componentwise join, and installs that result into receiver `resetAnchorCuts`. Thus uncompacted carrier-only X:100 and compact summary-only X:100 produce identical archive state. This applies independently of carrier maximality, displacement, and the new receiver anchor. The archive remains non-event absorption metadata, never enters `causalSummary`, and preserves no source journal entry or source `journalCoverage` coordinate.

Every new same-author carrier carries prior foreign causal context and is ordered after the preceding carrier by its local sequence. Cross-author succession requires the newer carrier's `causalContext` to cover the older carrier. `absorbsThrough` supplies only semantic absorption and may omit bookkeeping carriers so an unchanged reset stays silent. Exact semantic correspondences remain exact pairs and are never inferred or transitively copied from causal coordinates.
