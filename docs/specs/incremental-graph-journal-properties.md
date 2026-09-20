# IncrementalGraph Journal 3 Algebraic Properties

## Purpose

Journal 3 separates:

1. same-version retained-information union;
2. deterministic replay/normalization;
3. database-format migration; and
4. explicit lifecycle transitions which may author semantic history.

These layers have different algebraic behavior.

## Same-version retained-information order

For compatible supported retained journals J and K in one current format, `J <= K` iff every writer prefix in J is a prefix of the same writer in K.

Shared-prefix canonical equality is supplied by `incremental-graph-journal-theorems.md` Laws 8 and 8a; it is not an additional per-operation overlap scan. Same-ID disagreement, if encountered outside that supported domain, is corruption rather than another graph conflict.

## Causally closed prefix journals

For semantic `F=(W,q)`:

```text
F.context[W] == q - 1
```

and every included semantic event E satisfies componentwise:

```text
E.context <= F.context
```

Therefore `happenedBefore` is transitive.

Historical bootstrap ValueEvents may omit canonical foreign coordinates only under the controlled rule that upgrade read order is not legacy semantic causality; their actual stored contexts remain closed.

## Information join

For compatible causally closed prefix journals at one current version:

```text
J join K = immutable prefix union
```

It is idempotent, commutative, and associative. Join never rewrites a record.

## Replay is deterministic, not fieldwise graph join

`project(J)` is deterministic, but `project(J join K)` is not a fieldwise merge of current graph snapshots. Union may select another occurrence, change effective proof, reveal invalidation, stale a dependent, or require semantic normalization.

## Causality versus authority

`happenedBefore` is a transitive partial order. `authorityCompare` is a deterministic total precedence order extending it.

Coverage and reference legality use causality, not merely total authority.

## Certificate proof order

Certificate selection and effective-basis calculation are defined normatively in `incremental-graph-journal-replay.md` §Certificate selection and §Effective basis match.

The algebraic consequence used here is that greater clock authority alone cannot make a weaker effective proof replace stronger current proof; maintenance represents removed proof as explicit negative edge evidence.

## Invalidation scopes have distinct roles

Three scopes are intentionally different:

- `node` — real node invalidation; an unobserved node invalidation can invalidate certificates across value occurrences;
- `value(V)` — persistent freshness state for exact occurrence V without directly removing proof edges;
- `proof(V,D)` — maintenance-only negative evidence retiring incoming edge `D -> K` for exact occurrence V until a certificate causally observes that barrier and re-proves D.

A proof-edge barrier does not invalidate the whole certificate. Multiple barriers accumulate by removing the union of named edges from the selected certificate's effective basis.

Consequences:

- two replicas independently removing the same edge of the same V do not destroy unrelated retained proof;
- two replicas removing different edges produce the conservative intersection of their retained proof after union;
- barriers for V do not taint replacement occurrence V2;
- true explicit invalidation continues to use node scope.

## Persistent freshness is separate from recursive freshness

K may be replay-stale solely because an input is stale while K's own effective proof is complete.

Whenever graph semantics persist that stale transition, Journal persists `value(Kcurrent)` stale history too. Otherwise a later upstream `Unchanged` could erase the stored stale flag without K itself validating/recomputing.

This applies to ordinary propagation, synchronization, bootstrap, reset, and migration.

## Synchronization normalization is semantic authoring

Same-version raw union is order-independent, but synchronization may append receiver-authored:

```text
Delete(reason="sync")
Invalidate(reason="sync", scope=value(...))
```

These are real history. Hence convergence is required within each actual fair execution, not as byte-identical counterfactual confluence between schedules which authored different normalization events.

## Structural deletion versus stale cache retention

When a selected cached node loses a required materialized input, dependency closure requires explicit deletion.

When all required inputs remain present but their selected ValueIds/proof freshness differ from the cached dependent's certificate, the cached dependent remains a legitimate `oldValue`. Replay weakens its effective validity/freshness rather than deleting it merely because input histories are mixed.

## Reset is monotone history plus semantic repair

Conceptually:

```text
J0 = Jreceiver join Jsource
Jafter = J0 + required reset events
```

Reset's own-writer-ahead precondition is defined in `incremental-graph-journal-reset.md` §Preconditions and `incremental-graph-journal-lifecycle.md` §5.

Reset first inspects `selectedHeads(J0)`, not `project(J0)`: a compatible raw union may temporarily violate dependency closure even though receiver and source are each valid. Pass 1 repairs selected presence/immutable occurrence state to the valid source target; only then does full projection begin.

Reset preserves an occurrence when the raw selected head's immutable occurrence state already matches the target. For every non-target proof edge any eligible retained certificate could expose, reset authors `proof(V,D)` negative evidence; it does not invalidate the whole occurrence proof. Target persistent stale state gets `value(V)` marker when own effective proof is otherwise complete. Target absence gets DeleteEvent only when the raw selected head is a value.

Reset repairs causally follow the complete history it observed.

## Initial bootstrap is semantic identity plus historical merge

The pre-Journal -> Journal transition journals the already-persisted supported legacy graph. It does not run ordinary semantic migration first.

This makes bootstrap identity deterministic from persisted nodes, identifiers, payloads, timestamps, freshness, validity, allocator watermark, and graph interpretation rather than upgrade-time allocation/wall clock.

## Canonical bootstrap basis

The canonical artifact establishes shared ValueIds for occurrences equal to the frozen canonical cut.

Joining:

- reuses canonical ValueId for exact shared occurrence;
- converts local-only/different occurrence as historical joining-writer ValueEvent;
- keeps divergent values concurrent absent actual legacy causality;
- uses persisted legacy `modifiedAt` authority;
- treats legacy absence as no deletion evidence.

Two independent joiners may split identity for the same non-canonical occurrence; `$id-1635227135166767` explicitly accepts that limitation.

### Exact-shared proof/freshness merge

The exact-shared merge is defined by `incremental-graph-journal-migrations.md` §§7.3–7.4. This derived-properties document adds no competing merge rule.

## Creator resume is exact identity continuation

Canonical creation is selected by conditional first-creator publication, not by an earlier absence query. If canonical artifact publication succeeded but its response or creator cutover was lost, restart re-queries the canonical source. Same-fingerprint winner enters creator-resume and installs exactly that artifact after direct persisted-legacy equality validation; a different winner is joined instead. Creator-resume reruns no migration callback and authors no duplicate bootstrap history.

## Bootstrap compatibility is bounded

The artifact is the original frozen bootstrap cut. A running release joins it only if version/schema exactly equal that release's supported bootstrap target. No permanent decoder/migration ladder is implied.

## Established local writer state is monotone under the supported lifecycle

The fault-model and established-writer rollback boundary are defined normatively in `incremental-graph-journal-lifecycle.md` §5, with ordinary synchronization behavior in `incremental-graph-journal-sync.md` §Receiver-local writer ahead in the source is unsupported state.

The algebraic fact used here is only that supported existing-writer history is monotone; complete absence and continuation-safe restoration are a distinct lifecycle transition.

## Journal-aware migration representation is a total record transform

For fixed source->target database migration:

```text
Jconverted = rewriteJournalFormat(Jbefore, sourceVersion, targetVersion)
```

maps every retained source-format record to exactly one target-format representation while preserving ID, historical semantic fact, causal meaning, and references.

The transform is total over retained history, including records for node families absent from target schema. Independently, the source->target codec must be injective over the complete supported source NodeKey semantic domain, including valid keys absent from the current replica. Otherwise two independently migrated replicas could collapse different historical semantic nodes onto one target key and later merge them as one node. Such a codec is incompatible.

For semantic repair, the selected source projection is transported through the codec into target NodeKey representation while preserving ValueIds, NodeIdentifiers, timestamps, freshness, and rewritten proof/dependency endpoints. Migration decisions compare that target-keyed view with the target graph. A pure key-representation change therefore cannot be mistaken for source deletion plus target creation.

One pure payload codec rewrites every affected retained ValueEvent independent of selected status or replica-local state.

## Representation-only Journal migration uses codec + keep

Representation-only change is performed by the canonical whole-history codec. A selected occurrence whose semantic meaning survives uses `keep`; there is no second value-producing representation decision.

Journal-aware semantic changes use `invalidate`, `delete`, `create`, or another explicit semantic transition rather than redefining immutable historical bytes.

## Migration preserves occurrence identity when occurrence survives

`keep`, `invalidate`, schema/proof/freshness-only changes, and representation-only format rewrite preserve selected ValueId when the semantic occurrence survives.

True migration `invalidate(K)` is node-scoped. Other maintenance-only proof weakening uses `proof(V,D)` for every non-target edge in the eligible-certificate effective-proof union, so weakening the current winner cannot expose proof from a losing certificate.

## Genuine replacement migration may split identity

Independent migration may create different ValueIds for a genuine replacement occurrence. Later authority selects a winner; dependents naming a losing replacement may stale/recompute. This accepted trade-off avoids a mandatory canonical migration participant.

## Derived state is outside retained-history algebra

Materialized graph sublevels, indexes, checkpoints, staging replicas, transport cursors/branches, and cached summaries are not authoritative Journal elements. They may be rebuilt without changing semantic history, subject to replay equivalence and atomic cutover.
