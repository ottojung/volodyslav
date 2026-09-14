# Journal 3 Implementation Notes

This document contains non-normative engineering suggestions consistent with the normative Journal 3 model.

## Start with a simple reference replay

Implement correctness before clever indexes. A clear whole-history replay/reference model provides an oracle for optimized projection maintenance and synchronization tests.

## Keep imported and authored paths separate

Imported records should pass through immutable-record validation and retain IDs exactly.

Locally authored records should begin as transaction intents and receive final IDs/HLC coordinates only during serialized commit finalization.

Making those code paths distinct makes accidental re-authoring of foreign history harder.

## Use nominal types for validated journal boundaries

The repository's nominal-type convention fits Journal 3 well. Useful candidates include validated:

- JournalRecordId;
- JournalAuthor;
- JournalSequence;
- DecodedJournalRecord;
- CausallyClosedJournalSnapshot;
- ValueId known to reference a ValueEvent;
- Finalized local publication;
- Compatible synchronization source.

Proof comments should enumerate exact introduction paths.

## Prefer immutable event objects after decoding

Once a persisted record has passed codec/well-formedness validation, internal code should not mutate its body/context/authority.

Derived annotations belong in indexes/read models, not on the authoritative event object.

## Separate history indexes from authority

A current-head index can dramatically speed replay queries, but its API should make it obvious it is a cache.

A useful debugging/test mode is to delete/rebuild all Journal indexes and compare the resulting projection.

## Keep current schema derivation explicit

Structural `inputEdges(K)` remain schema-derived. Code performing replay/normalization should obtain them through one well-defined graph-schema service rather than duplicate expression/key parsing in Journal modules.

## Use durable staging for large sync

Suffix imports can be streamed into an inactive sublevel/replica rather than accumulated in memory.

Only after all required ranges, normalization, replay, and validation succeed should active cutover occur.

## Build the reverse structural index as derived state

Synchronization normalization needs affected dependent closure. A derived reverse structural-edge index is likely valuable and was already identified by #1607.

Its correctness should be checked against schema-derived `inputEdges`, and it must be rebuildable.

## Preserve a diagnostic reason field

`reason` tags are not conflict authority but are valuable for replay inspection:

```text
compute
explicit
propagated
sync
bootstrap
reset
migration
```

Avoid making projection semantics depend on reason where scope/causality/value identity already define meaning.

## Make corruption errors local and inspectable

A bad record should report its writer/sequence and exact violated rule. Avoid generic "journal invalid" errors when diagnostics can point to a specific malformed reference or gap.

## Optimize only behind equivalence tests

When adding incremental replay/current-head/certificate indexes, preserve a test path which recomputes from authoritative records and compares projections.

This gives Journal 3 a long-term way to evolve performance without turning caches into accidental authority.
