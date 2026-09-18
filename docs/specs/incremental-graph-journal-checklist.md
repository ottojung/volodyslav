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
- certificate selection exactly matches `incremental-graph-journal-replay.md` §Certificate selection;
- no positive certificate mixing;
- multiple `proof(V,D)` barriers may accumulate negative edge evidence;
- `proof(V,D)` affects only edge D of occurrence V; `value(V)` controls persistent freshness without itself removing validity;
- freshness/validity reproduce graph semantics;
- full rebuild works.

## 7. Lifecycle-owned storage and absent-installation restore

Acceptance:

- existing local persistent state is accepted only when produced by supported Volodyslav lifecycle transitions;
- complete disappearance of the local database is the supported external-loss case and yields the `Absent` state;
- partial deletion, rollback to an older local state, mixed snapshots, partial restoration, or direct external mutation are corrupted/unsupported rather than new recovery cases (`$id-6158827469032147`);
- a crash/interruption of a supported transition exposes only a state permitted by that transition's atomicity/crash rules;
- installation recovery source is queried only for an absent local database and before fresh fingerprint generation;
- source exists -> restore/adopt `localWriter` only when the held snapshot establishes a **continuation-safe head** as defined by `incremental-graph-journal-lifecycle.md` §4.1;
- continuation-safe means no higher record for that writer can later re-enter supported history after absent-state restoration;
- source definitely absent -> fresh creation allowed;
- source read/query failure -> fail, no fresh fallback;
- writer head/allocator watermark/authority high-water/projection reconstructed before new allocation;
- allocator watermark is reconstructed from the same continuation-safe retained writer prefix; indices allocated only in a discarded suffix may be reused only when that suffix cannot later enter supported retained history;
- records lost only with the completely lost local database and unable to re-enter supported history do not by themselves make the restored head unsafe;
- establishing absent-restoration safety does not require contacting/discovering every possible peer (`$id-4719065396881648`);
- an existing local database is never routed through absent restore merely because some of its data is missing or old.

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
- a path needing semantic `create`/`invalidate`/`delete`, schema-semantic transformation, wall clock, randomness, or allocator-dependent new graph identity is rejected as incompatible before bootstrap history;
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
- joining historical ValueEvents are allocated in nondecreasing `(modifiedAt, canonical NodeKey)` order before joining records whose contexts include canonical coordinates;
- divergent values remain concurrent absent genuine legacy causality;
- canonical-present/local-absent does not fabricate delete;
- maintain `joiningOccurrenceValueId(K)` for every joining legacy materialization: canonical ValueId when exact-shared, otherwise the joining ValueEvent ID even if that occurrence loses selection;
- locally-authored validation bases use the joining host's own legacy input occurrence ValueIds, never a different occurrence merely because it won conflict selection;
- local dependent whose legacy-valid input loses to a newer selected occurrence is hard stale, not fresh;
- exact shared validity is `canonicalValid ∩ joiningValid`;
- every canonical proof edge absent on the joining side gets a `proof(sharedV,input)` bootstrap barrier; joining-only proof never strengthens canonical proof;
- exact shared occurrence is stale if canonical OR joining legacy copy is stale, with uncovered value-scoped bootstrap marker as required after proof-edge barriers;
- a joining explicit invalidation on a canonical-fresh shared occurrence therefore remains hard stale and cannot cache-revalidate from canonical proof alone;
- after direct proof/stale roots, deterministic topological J2b pass persists every selected occurrence stale solely through a stale input;
- later upstream `Unchanged` cannot silently freshen such bootstrap-stale dependent;
- post-bootstrap validations unseen by a late join are concurrent with that join's negative proof/stale evidence and do not clear it until a causally later validation occurs;
- two joiners may split same non-canonical occurrence ValueId as accepted by `$id-1635227135166767`;
- stale partial validity uses controlled `"unknown"`;
- cutover atomic.

## 9. Pairwise synchronization

Acceptance:

- compatibility from held source snapshot;
- every missing **foreign-writer** suffix imported;
- overlap verified;
- own-writer-ahead handling matches `incremental-graph-journal-lifecycle.md` §5 and `incremental-graph-journal-sync.md` §Receiver-local writer ahead in the source is unsupported state;
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
- fair normalization reaches fixed point;
- a quiescent H-replica gather-to-one/broadcast-from-one schedule settles within at most `2(H-1)` state-advancing successful pairwise synchronizations, implying the required H^2 achievable bound.

## 11. Reset

Acceptance:

- source target/compatibility from one held snapshot;
- own-writer-ahead reset behavior matches `incremental-graph-journal-reset.md` §Preconditions and `incremental-graph-journal-lifecycle.md` §5;
- unchanged target occurrence preserves ValueId;
- new ValueEvent only for actual occurrence replacement;
- reset computes `eligibleEffectiveProofUnion(K)` from the fixed post-value-repair cut and barriers every non-target edge any eligible retained certificate could expose, using `Invalidate(scope=proof(V,D),reason=reset)`;
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
- directed source->target `JournalFormatCodec` is declared by the migration definition and defaults missing transforms to identity;
- `rewriteNodeKey` and `rewriteComputedValue` are synchronous, deterministic, and capability-free;
- rewrite is total over retained source history, including records for node families absent from target schema and non-selected ValueEvents;
- every embedded NodeKey is rewritten, including record keys, validation-basis inputs, and proof-scope inputs;
- `rewriteNodeKey` is a codec-level injective mapping over every valid source semantic NodeKey which may occur in supported source-version Journal history, independent of one replica's retained subset;
- local migration scans reject any collision they actually observe, but are not treated as proof of the global injectivity contract;
- rewritten ValidationBasis entries are re-sorted by the target canonical NodeKeyString order;
- semantic migration repair uses the codec-transported source projection in target key space, not source-keyed `Gbefore` directly;
- Journal-aware `get`/traversal remain source-NodeIdentifier/source-representation operations;
- `keep(id(Ks))` and `invalidate(id(Ks))` perform target-schema compatibility against `rewriteNodeKey(Ks)`, not Ks;
- `create(Kt,...)` treats Kt as target representation and fails `CreateExistingNodeError` when Kt equals `rewriteNodeKey(Ks)` for any previously materialized source Ks;
- non-identity `Ks -> Kt` plus `keep(id(Ks))` preserves the original ValueId and authors neither replacement ValueEvent nor spurious delete;
- non-total/throwing source->target codec fails `JournalVersionCompatibilityError` before cutover;
- same historical record rewrites identically across replicas;
- representation-only change uses `keep` plus the canonical codec;
- the Journal 3 implementation must delete the legacy representation-rewrite path when this specification is implemented: `MigrationStorage.override()`, the `OverrideDecision` typedef, `OverrideConflictError`, and every `override` branch in `migration_runner.js` and `migration_validity.js`; no compatibility flag or unreachable duplicate mechanism remains;
- `keep` preserves occurrence ValueId, timestamps, freshness, and target-shape-compatible source replay validity even when the node is stale;
- stale `keep` alone does not create proof barriers or force recomputation;
- explicit migration `invalidate(K)` preserves occurrence ValueId and authors true node-scoped invalidation;
- maintenance-only proof weakening for preserved V barriers every `D` in `eligibleEffectiveProofUnion(K) - TargetValid(K)`, not merely edges of the initially selected certificate and not a whole-ValueId or node barrier;
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
- valid authoritative Journal history may rebuild derived projection/indexes;
- rebuild is not permitted to repair missing/truncated authoritative Journal history or local rollback;
- invalid/known-incomplete history rejected;
- context closure, allocator, high-water, indexes reconstructible/validated.

## 14. Error model

Provide actionable categories for writer fork, bootstrap fork, stream gap, causal closure, reference causality, current-format validation, ordinary snapshot/bootstrap compatibility, own-writer-behind unsupported state, projection failure, publication/source-read failure.

Bootstrap incompatibility specifically includes a would-be pre-Journal target requiring semantic/time/allocator-dependent migration before Journal identity exists.

Journal-aware migration incompatibility includes a format migration whose codec is not total over retained source-format history and therefore fails `JournalVersionCompatibilityError`.

## 15. Reference model / property verification

The normative regression/property inventory is `incremental-graph-journal-testing.md`. Completion of this checklist requires that the implementation/reference model satisfy that inventory; this checklist does not maintain a second copy.

## 16. Performance boundary

Issue #1607 owns end-to-end change-sensitive synchronization complexity. Correctness must not be weakened for unstated performance goals.

## 17. Completion condition

Journal 3 implementation is complete only when ordinary operations, startup/absent restore, bootstrap/migration, synchronization, reset, restart/open, and rebuild preserve:

```text
persistedGraph == project(retainedJournal)
```

with the lifecycle fault model, causal, identity, compatibility, proof, and persistent-freshness laws above covered by tests/models.
