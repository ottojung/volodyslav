# IncrementalGraph Journal 3 Algebraic Properties

## Purpose

Journal 3 separates:

1. same-version retained-information union;
2. deterministic replay/normalization;
3. database-format migration; and
4. explicit lifecycle transitions which may author semantic history.

These layers have different algebraic behavior and must not be conflated.

## Same-version retained-information order

For compatible retained journals J and K in one current format, define `J <= K` iff every writer prefix in J is a prefix of same writer in K and overlapping records have identical canonical meaning.

Overlap disagreement is a fork/corruption condition rather than another semantic merge input.

## Causally closed prefix journals

For semantic F=(W,q):

```text
F.context[W] == q - 1
```

and every included event E has `E.context <= F.context` componentwise.

Therefore `happenedBefore` is transitive.

Historical bootstrap ValueEvents may omit canonical foreign coordinates only under the controlled rule that physical upgrade read order is not semantic legacy causality. Their actual stored context remains closed.

## Information join

For compatible causally closed prefix journals at one current version:

```text
J join K = immutable prefix union
```

It is idempotent, commutative, and associative for mutually compatible histories. Join never rewrites a record.

## Replay is deterministic, not fieldwise join

`project(J)` is deterministic, but `project(J join K)` is not a fieldwise merge of graph projections. Union can select another occurrence, change certificate eligibility/selection, reveal invalidation, make dependents stale, or require explicit normalization.

## Information growth versus semantic state

Ordinary authoring, sync, reset, migration repairs, and bootstrap joining grow retained information, while projected presence/value/freshness/validity may move in either direction.

## Causal relation versus total authority

`happenedBefore` is a transitive partial causal order. `authorityCompare` is a deterministic total conflict-precedence order extending it.

Coverage/eligibility use causality, not merely total authority.

## Certificate proof order

For eligible certificates of current ValueId, replay maximizes:

```text
basisMatchCount
coversValueInvalidations
then authority
```

A later weaker certificate therefore cannot necessarily supersede an older stronger certificate by authority alone.

## Invalidation scopes have distinct algebraic roles

Three scopes are not interchangeable:

- `node` is genuine node invalidation and can make certificates for different occurrences ineligible until causally covered;
- `value(V)` is persistent freshness state for occurrence V and does not by itself remove validity edges;
- `proof(V)` is maintenance authority over certificate eligibility for V only.

A `proof(V)` barrier permits monotone retained history to project to weaker validity: older stronger certificates for V remain retained but become ineligible. It does not taint a concurrent/later V2.

This occurrence scope is essential when reset/migration merely weakens proof. True explicit invalidation continues to use node scope.

## Persistent freshness is separate from recursive freshness

K can be replay-stale solely because an input is stale even while K's own proof is complete.

When graph semantics persist that fresh->stale transition, Journal must also persist a value-scoped marker for K. Otherwise later upstream `Unchanged` could erase the stored stale flag without K validating.

This obligation applies to ordinary propagation, sync, bootstrap merge, reset, and migration whenever they intentionally create/reproduce such state.

## Normalization is semantic authoring, not pure join

Synchronization may append receiver DeleteEvents and value-scoped stale markers. They are immutable semantic history, not temporary annotations.

Therefore normalization depends on one actual receiver execution, while raw compatible union remains order-independent.

## Convergence is not counterfactual confluence

Different fair schedules may author different real normalization records before all concurrent facts are known. Journal 3 requires each actual fair execution to reach a finite fixed point after non-normalization graph changes stop; it does not require different counterfactual histories to be byte-identical.

## Reset is monotone history plus semantic repair

Conceptually:

```text
J0 = Jreceiver join Jsource
Jafter = J0 + required reset events
```

Reset preserves selected occurrence when target occurrence already matches. For weaker target proof of preserved V, it authors `proof(V)` barrier then target certificate. Target persistent stale state gets `value(V)` marker when own proof is otherwise ready. Target absence gets DeleteEvent exactly when J0 selects value.

Reset repairs intentionally causally follow J0.

## Initial bootstrap is semantic identity plus historical merge

The first pre-Journal -> Journal transition is not an ordinary graph migration. It journals the already-persisted supported legacy graph with the same materialized nodes, identifiers, payloads, timestamps, freshness, validity, allocator watermark, and graph interpretation.

This prevents bootstrap identity from depending on execution-time `create()` timestamps or host-local allocation decisions.

If reaching a proposed bootstrap target would require a semantic legacy migration, that source/target pair is incompatible with automatic bootstrap. Actual graph/schema semantic migration happens before reaching the supported source state or later as Journal-aware migration.

## Canonical bootstrap basis

Pre-Journal replicas have no ValueIds. Canonical artifact establishes shared identity for occurrences equal to canonical cut.

Joining does not reset canonical cut to local cache:

- equal occurrence reuses canonical ValueId;
- different/local-only occurrence becomes historical joining ValueEvent;
- divergent values remain concurrent absent actual legacy causality;
- authority is seeded from persisted legacy `modifiedAt`;
- canonical presence/local absence creates no DeleteEvent.

Two independent joiners may assign distinct ValueIds to same non-canonical occurrence, accepted by `$id-1635227135166767`.

### Shared stale merge is conservative

For an exact shared occurrence V, canonical proof remains proof basis. Join does not author a causally-later validation merely to strengthen joining proof.

```text
joined stale(V) = canonical stale(V) OR joining stale(V)
```

Thus a fresh joiner cannot clear canonical stale evidence. After direct stale roots, bootstrap propagates value-scoped stale markers forward wherever selected own proof is complete and a direct input is stale.

## Creator resume is identity continuation

If canonical artifact is durable but creator crashed before local cutover, same-fingerprint creator compares persisted legacy graph **directly** to artifact projection under semantic-identity bootstrap. No legacy migration callback reruns.

Match installs exact artifact; mismatch is bootstrap fork.

## Bootstrap artifact is original cut and compatibility is bounded

Joining uses only records through frozen bootstrap frontier, never later current history.

A running release may interpret artifact only when target version/schema equals release expected bootstrap target. No permanent historical decoder/migration ladder is implied.

## Journal-aware migration representation is not same-version join

Format-changing migration applies deterministic recordwise transform:

```text
Jconverted = rewriteJournalFormat(Jbefore, sourceVersion, targetVersion)
```

preserving old IDs and semantic/causal/reference facts. Same-version `<=`/join relation is not applied across source/target physical representations.

## Record-format migration is a function of the record

For fixed source->target migration definition, each retained record has one canonical target representation independent of selection/replica-local state.

This prevents one immutable JournalRecordId from migrating to conflicting target bodies.

## `override()` is representation change, not occurrence change

Valid Journal-aware override preserves ValueId/semantic value/NodeIdentifier/timestamps/causal identity. Callback asserts agreement with canonical per-record codec rather than independently defining immutable bytes.

## Migration preserves occurrence identity when occurrence survives

`keep`, `override`, `invalidate`, schema-only, proof-only, and freshness-only changes preserve selected ValueId when cached occurrence survives.

Explicit migration `invalidate(K)` is a true node invalidation. Other maintenance-only proof weakening for V uses `proof(V)` barrier rather than node scope.

## Genuine replacement migration may split identity

Independent migration may create different ValueIds for genuine replacement occurrence. Later authority picks winner; dependent certificates naming loser may stale/recompute. This is accepted and requires no canonical migration participant.

## Derived state is outside retained-history algebra

Materialized graph sublevels, indexes, checkpoints, staging replicas, transport branches/cursors, and cached summaries are not authoritative Journal elements.

Canonical bootstrap artifact is lifecycle source state rather than active current JournalReplica. Derived state may be rebuilt without changing semantic history, subject to atomic cutover/replay equivalence.