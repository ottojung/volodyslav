# IncrementalGraph Journal 3 Implementation Checklist

## Purpose

This checklist translates normative Journal 3 specifications into implementation milestones and acceptance checks. It is not a second design.

## 1. Persisted journal primitives

Implement durable current-version representations for `JournalRecordId`, `JournalFrontier`, `AuthorityTime`, Value/Delete/Validate/Invalidate events, and `WriterStateRecord`.

Acceptance:

- `global/version` is the only persisted format selector for an active replica;
- no per-record version discriminator;
- ordered per-writer range iteration;
- canonical current-format codec;
- validation bases are explicit, duplicate-free, canonical NodeKeyString order;
- Invalidate scope distinguishes `node`, `value(ValueId)`, and `proof(ValueId,inputNodeKey)`;
- no public arbitrary Journal mutation API.

## 2. Causal context and reference validation

Acceptance:

- semantic `(W,q)` has `context[W] == q-1`;
- every context coordinate is retained;
- if F includes semantic E then `E.context <= F.context` componentwise;
- malformed transitive omission rejected;
- happened-before transitive and implies increasing authority;
- value/proof scopes reference a causally prior ValueEvent for the same node;
- proof scope carries a canonical semantic input NodeKey identifying the retired incoming edge;
- bootstrap historical-value conversion may omit canonical foreign coordinates only under explicit lifecycle rule while its actual context remains closed.

## 3. Journal snapshots

Implement stable `JournalSnapshot` with exact `databaseVersion`, `graphSchemeString`, `localWriter`, frontier, and records from one committed source state.

Do not reuse ordinary `JournalSnapshot` as canonical-bootstrap artifact.

## 4. Local publication finalization

Acceptance:

- failed transactions leave no durable sequence hole;
- concurrent successes receive disjoint contiguous ranges;
- IDs/contexts/HLCs finalized under serialized publication;
- own-writer context exact;
- graph+Journal publish atomically;
- volatile allocator/index state advances only after durable success.

## 5. Ordinary graph emission

Cover fresh no-op, materialization, changed recompute, `Unchanged`, cache revalidation, explicit node invalidation, propagated value invalidation, deletion, and allocator advancement.

For every successful case:

```text
project(journalAfter) == graphAfter
```

## 6. Replay engine

Acceptance:

- deterministic value/delete head selection;
- transitive/reference causality enforced;
- certificate shape compatibility deterministic;
- whole-certificate eligibility rejects uncovered node invalidation;
- proof-edge barriers are applied per basis edge rather than making the entire certificate ineligible;
- certificate ordering is `effectiveBasisMatchCount`, then value-invalidation coverage, then authority;
- no positive certificate mixing;
- multiple `proof(V,D)` barriers may accumulate negative edge evidence;
- `proof(V,D)` affects only edge D of occurrence V; `value(V)` controls persistent freshness without itself removing validity;
- freshness/validity reproduce graph semantics;
- full rebuild works.

## 7. Absent-installation restore

Acceptance:

- installation recovery source queried before fresh fingerprint generation;
- source exists -> restore/adopt `localWriter` only when source guarantees the complete own-writer stream ever durably published for that writer;
- a readable but potentially lagging snapshot returns indeterminate/error and MUST NOT be used for writer continuation;
- source definitely absent -> fresh creation allowed;
- source read/query failure -> fail, no fresh fallback;
- writer head/watermark/high-water/projection reconstructed before new allocation;
- stale recovery snapshot `A:1..900` is rejected for continuation when `A:901..905` may already have been published elsewhere.

## 8. Pre-Journal bootstrap

Acceptance:

- cohort source returns exactly exists / definitely absent / indeterminate-or-error;
- exists returns immutable `CanonicalBootstrapSnapshot`, not current Journal snapshot;
- definite absence permits canonical creation only under first-creator arbitration;
- indeterminate/error fails without competing creation;
- artifact exposes exactly original `bootstrapFrontier` and expected target version/schema;
- unsupported artifact target fails `JournalVersionCompatibilityError` before history;
- no indefinite historical target support is required;
- artifact durable before ordinary post-bootstrap authoring;

### Bootstrap semantic-identity target

- bootstrap journals the persisted legacy graph directly;
- materialized NodeKeys, NodeIdentifiers, payloads, timestamps, freshness, validity, allocator watermark, and graph interpretation are preserved exactly at the cut;
- no ordinary legacy migration callback runs before canonical bootstrap;
- a path needing `MigrationStorage.create()`, semantic `override`/`invalidate`/`delete`, schema-semantic transformation, wall clock, randomness, or allocator-dependent new graph identity is rejected as incompatible before bootstrap history;
- actual graph/schema migration happens after bootstrap via Journal-aware migration.

### Creator resume

- artifact creatorWriter equal to local pre-Journal fingerprint -> creator-resume, not foreign join;
- compare artifact projection directly with persisted legacy semantic graph; do not rerun migration callback;
- install exactly artifact history and reconstruct writer head/watermark/high-water/projection;
- matching state cuts over without duplicate semantic records;
- mismatch fails `JournalBootstrapForkError`;
- another fingerprint cannot use creator-resume.

### Ordinary join

- preserves joining fingerprint/watermark;
- is historical legacy merge, not reset;
- exact occurrences reuse canonical ValueIds;
- local-only/different occurrences become historical joining ValueEvents using persisted legacy `modifiedAt` authority;
- divergent values remain concurrent absent genuine legacy causality;
- canonical-present/local-absent does not fabricate delete;
- exact shared validity is `canonicalValid ∩ joiningValid`;
- every canonical proof edge absent on the joining side gets a `proof(sharedV,input)` bootstrap barrier; joining-only proof never strengthens canonical proof;
- exact shared occurrence is stale if canonical OR joining legacy copy is stale, with uncovered value-scoped bootstrap marker as required after proof-edge barriers;
- a joining explicit invalidation on a canonical-fresh shared occurrence therefore remains hard stale and cannot cache-revalidate from canonical proof alone;
- after direct proof/stale roots, deterministic topological J2b pass persists every selected occurrence stale solely through a stale input;
- later upstream `Unchanged` cannot silently freshen such bootstrap-stale dependent;
- two joiners may split same non-canonical occurrence ValueId as accepted by `$id-1635227135166767`;
- stale partial validity uses controlled `"unknown"`;
- cutover atomic.

## 9. Pairwise synchronization

Acceptance:

- compatibility from held source snapshot;
- every missing **foreign-writer** suffix imported;
- overlap verified;
- a longer agreeing prefix of the receiver's own local writer causes `JournalWriterBehindError` rather than ordinary-sync continuation;
- same-writer continuation is allowed only through a continuation-safe recovery source which guarantees the complete published own stream;
- a generic/lagging peer snapshot cannot authorize resumed same-writer allocation;
- fork rejected;
- transfer streamable;
- imported records unchanged;
- no computor execution or transport acknowledgement event.

## 10. Synchronization normalization

Acceptance:

- structural closure authors explicit sync deletes;
- every selected occurrence stale solely through direct-input staleness gets/retains current-value sync invalidation;
- includes newly selected remote ValueIds;
- proof deficiency/node invalidation/already-uncovered value marker do not create unnecessary duplicate marker;
- repeat sync no-op;
- fair normalization reaches fixed point.

## 11. Reset

Acceptance:

- source target/compatibility from one held snapshot;
- union history retained only after any own-writer-behind condition has been resolved through continuation-safe recovery;
- unchanged target occurrence preserves ValueId;
- new ValueEvent only for actual occurrence replacement;
- for every removed incoming edge `D -> K` of preserved V, reset authors `Invalidate(scope=proof(V,D),reason=reset)`;
- old proof cannot reintroduce a barriered edge;
- concurrent barriers for different inputs compose by removing the union of named edges;
- barrier for `(V,D)` does not invalidate unrelated proof or certificates for another ValueId V2;
- proof additions require no barrier solely for being additions;
- target proof uses exact ValueIds/`"unknown"` edge set;
- target persistent stale with own effective proof ready gets value-scoped reset marker even if recursively stale already;
- later upstream `Unchanged` does not freshen such target-stale K;
- deterministic target absence delete;
- repeat satisfied reset may no-op;
- receiver allocator remains local;
- replay equals target semantic graph;
- reset causal-later semantics never reused for bootstrap conflicts.

## 12. Journal-aware migration

Acceptance:

- retained old history deterministically rewritten into one target format preserving IDs/meaning;
- rewrite is total over retained source history, including records for node families absent from target schema;
- per-record payload codec independent of selected status/replica-local state;
- same historical record rewrites identically across replicas;
- representation-only change uses `keep` plus canonical codec; Journal-aware execution rejects legacy value-producing `override()`;
- explicit migration `invalidate(K)` preserves occurrence ValueId and authors true node-scoped invalidation;
- maintenance-only proof weakening for preserved V uses one `proof(V,D)` barrier per removed incoming edge, not a whole-ValueId or node barrier;
- two replicas independently weakening the same V to the same partial proof retain that partial proof after synchronization;
- barriers for different inputs compose to the intended intersection;
- proof barrier for `(V,D)` does not taint V2 or unrelated V edges;
- proof/freshness/schema change alone creates no ValueEvent;
- target persistent stale with own effective proof ready gets value marker even if recursive input staleness already makes replay stale;
- genuine create/replace creates new ValueId;
- independent replacements may later conflict/stale dependents as accepted;
- no particular peer required for migration;
- target replay equals migration target including stale persistence;
- replay never reruns historical migration callback;
- whole-history rewrite may be O(history) and streamable.

## 13. Open/rebuild lifecycle

Acceptance:

- one current format per active replica;
- bootstrap artifact interpreted only by software explicitly supporting its target;
- known graph/Journal mismatch not exposed;
- valid history rebuilds projection;
- invalid history rejected;
- context closure, allocator, high-water, indexes reconstructible/validated.

## 14. Error model

Provide actionable categories for writer fork, bootstrap fork, stream gap, causal closure, reference causality, current-format validation, ordinary snapshot/bootstrap compatibility, unsafe writer continuation, projection failure, publication/source-read failure.

Bootstrap incompatibility specifically includes a would-be pre-Journal target requiring semantic/time/allocator-dependent migration before Journal identity exists.

Journal-aware migration incompatibility includes a format migration whose codec is not total over retained source-format history.

## 15. Reference model / property verification

Priority regressions/properties:

- deterministic replay;
- causal transitivity and authority extension;
- prefix-union algebra;
- local emission preservation;
- invalidation-aware certificate selection;
- proof-edge barriers compose on the same V without destroying unrelated proof;
- maintenance stale state survives later upstream `Unchanged`;
- stable snapshot compatibility;
- selected-remote stale persistence;
- repeat-sync no-op and normalization convergence;
- absent restore vs fresh creation;
- ordinary peer revealing a longer local-writer prefix fails `JournalWriterBehindError` before sync publication;
- stale own-writer recovery source cannot resume a previously published coordinate;
- canonical bootstrap source decision/original cut;
- bootstrap graph-semantic identity and rejection of current legacy `create()` path;
- creator crash resumes exact artifact without migration callback rerun;
- exact shared canonical-stale + joining-fresh remains stale;
- exact shared proof intersection preserves joining explicit invalidation;
- joining stale shared input persistently stales canonical dependent;
- legacy conflict uses persisted modifiedAt rather than upgrade time;
- legacy absence does not fabricate delete;
- accepted non-canonical identity split;
- unsupported historical target fails compatibility;
- total pure format rewrite over selected/non-selected/target-removed history;
- independent replacement migration trade-off;
- minimal deterministic reset.

## 16. Performance boundary

Issue #1607 owns end-to-end change-sensitive synchronization complexity. Correctness must not be weakened for unstated performance goals.

## 17. Completion condition

Journal 3 implementation is complete only when ordinary operations, startup/restore, bootstrap/migration, synchronization, reset, restart/open, and rebuild preserve:

```text
persistedGraph == project(retainedJournal)
```

with the causal, identity, compatibility, proof, and persistent-freshness laws above covered by tests/models.
