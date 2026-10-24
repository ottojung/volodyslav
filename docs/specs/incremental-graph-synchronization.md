# Incremental Graph Synchronization

This document is retired as a specification. Journal synchronization has one
canonical normative owner:

- `incremental-graph-journal-sync.md` — suffix replication, normalization,
  convergence, and the host-count settling construction.

That ownership is declared by the Journal 3 reading order
(`incremental-graph-journal-README.md`, §Normative ownership: "Each semantic
rule has one normative owner").

This file previously restated the same synchronization contract in parallel.
Two competing full specifications violated the one-owner rule above and the
documentation-cutover requirement in
`incremental-graph-journal-checklist.md` §16a ("There must be one obvious
canonical shipped specification for synchronization"). The file is retained
only as a pointer so existing references resolve; it is not a competing
definition of any synchronization rule. This discharges §16a's instruction to
replace or rewrite `incremental-graph-synchronization.md` so the canonical
synchronization specification describes shipped Journal 3 behavior: the owner
above now carries that contract, and this file is only a redirect to it.

The obligations that appeared only in the retired text — "Synchronization MUST
NOT invoke computors" and the scope/non-goals statements — are restated in
`incremental-graph-journal-sync.md` §Scope and non-goals. The bounded-memory
iteration contract remains owned by `$id-4924739474925738`.

The retired text also specified a legacy pairwise materialization merge. Journal
3 synchronization replaces that mechanism with immutable foreign-suffix import
plus deterministic replay, so those merge-domain requirements are superseded
rather than silently dropped. The canonical owner
`incremental-graph-journal-sync.md` states the live rules.

Superseded by Journal 3 replay and identity semantics:

- `REQ-SYNC-07`, `REQ-SYNC-08`, `REQ-SYNC-08a`, `REQ-SYNC-08b`,
  `REQ-SYNC-08c` (timestamp-based candidate selection and merge-time
  freshness): Journal 3 selects values by replay and `ValueId`, not by the
  `(modifiedAt, NodeIdentifier, sourceFingerprint)` tuple, and authors no merge
  timestamp. The same-coordinate stale-freshness rule is vacuous because
  identifiers embed the host fingerprint and the immutable-overlap law forbids
  writer forks.
- `REQ-SYNC-08d` (selected record timestamp copy): Journal 3 carries the exact
  `createdAt`/`modifiedAt` instant of the selected `ValueEvent` through
  deterministic replay; it never substitutes merge-execution time nor combines
  timestamps across sources. Owned by `incremental-graph-journal-replay.md`
  §timestamps.
- `REQ-SYNC-09`, `REQ-SYNC-10` (distinct-input classifier; structural deletion
  closure): owned by `incremental-graph-journal-sync.md` §Phase 1:
  dependency-closure removal.
- `REQ-SYNC-11`, `REQ-SYNC-12`, `REQ-SYNC-13` (final identifier selection;
  meaning of `potentially-outdated`; equality does not create origin): Journal
  3 identity and freshness are owned by `incremental-graph-journal-replay.md`.
- `REQ-SYNC-14`, `REQ-SYNC-15`, `REQ-SYNC-16`, `REQ-SYNC-17` (validity-proof
  transport): Journal 3 rebuilds proofs by replay; there is no source-side proof
  transport. Owned by `incremental-graph-journal-replay.md`.
- `DEF-SYNC-02` (source-version identity): replaced by `ValueId` identity and
  the immutable-overlap law; equal timestamps, identifiers, or stored values are
  no longer identity evidence.
- `DEF-SYNC-01`, `DEF-SYNC-03`, `DEF-SYNC-04`, `DEF-SYNC-05` (value origin;
  semantic merge domain; selected source side; final outcome): per-key
  byte-source selection has no Journal counterpart. Journal 3 admits values by
  importing foreign suffixes and selecting heads by replay, with occurrence
  identity carried by `ValueId` (`incremental-graph-journal-sync.md` §Imported
  causal closure and §Normalization versus raw union;
  `incremental-graph-journal-replay.md`). These definitions remain implemented
  only by the pre-Journal fieldwise merge engine
  (`backend/src/generators/incremental_graph/database/sync_merge_plan.js`,
  `sync_merge_apply.js`), which refuses Journal-backed replicas
  (`JournalBackedFieldwiseMergeError` in `sync_merge.js`).
- `DEF-SYNC-06`, `DEF-SYNC-07`, `DEF-SYNC-08` (taint propagation; direct
  invalidation candidates; direct relowering): no Journal counterpart.
  Opposite-side ancestry and selected-source provenance do not exist once the
  merge mechanism is replaced; dependent removal and staleness are owned by
  `incremental-graph-journal-sync.md` §Phase 1: dependency-closure removal and
  §Phase 2. Implemented only by the pre-Journal engine cited above.
- `DEF-SYNC-09` (source validity proof): no Journal counterpart. Journal 3
  rebuilds proofs by replay; there is no source-side proof transport. Owned by
  `incremental-graph-journal-replay.md`; implemented for pre-Journal peers by
  `backend/src/generators/incremental_graph/database/sync_merge_validity.js`.

Still applicable, with their equivalent owner:

- `REQ-SYNC-04`, `REQ-SYNC-05` (source and final consistency): a source whose
  retained records are inconsistent with its projection is rejected rather than
  silently dropped. Owned by `incremental-graph-journal-well-formedness.md`
  and `incremental-graph-journal-sync.md` §Final replay and validation.
- `REQ-SYNC-06` (malformed-metadata rejection): malformed immutable context and
  duplicate/conflicting records are rejected rather than silently dropped.
  Owned by `incremental-graph-journal-well-formedness.md` and
  `incremental-graph-journal-sync.md` §Imported causal closure and §Final replay
  and validation.
- `REQ-SYNC-11a` (up-to-date eligibility): the `selfProofReady(K) => fresh(K)`
  gate in `incremental-graph-journal-sync.md` §Final replay and validation.
- `REQ-SYNC-18`, `REQ-SYNC-19` (pre-switch validation; fail-closed on failure):
  `incremental-graph-journal-sync.md` §Final replay and validation and §Atomic
  publication.
- `REQ-SYNC-20`, `REQ-SYNC-22` (write-target isolation; partial-failure safety):
  `incremental-graph-journal-sync.md` §Atomic publication, which streams into
  inactive staging and leaves the previous active pair selected on failure.
- `REQ-SYNC-21` (switch condition): a successful synchronization publishes the
  final pair atomically and is a semantic no-op when nothing changed.
  `incremental-graph-journal-sync.md` §Atomic publication and §Pairwise result
  law.

See `incremental-graph-journal-README.md` for the Journal 3 reading order.
