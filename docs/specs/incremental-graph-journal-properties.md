# IncrementalGraph Journal 3 Algebraic Properties

## Purpose

Journal 3 separates:

1. same-version retained-information union;
2. deterministic projection/normalization;
3. database-format migration; and
4. explicit lifecycle transitions which may author semantic history.

These layers have different algebraic behavior and must not be conflated.

## Same-version retained-information order

For compatible retained journals J and K in one current database format, define `J <= K` iff every writer prefix in J is a prefix of same writer in K and every overlapping record has identical canonical meaning.

If overlapping content differs, journals are not compatible under this relation; that is writer fork/corruption.

## Causally closed prefix journals

A supported semantic-event context is a causally closed frontier.

For F=(W,q):

```text
F.context[W] == q - 1
```

and if F.context includes E then `E.context <= F.context` componentwise.

Therefore direct context/same-writer definition of `happenedBefore` is transitive.

A historical bootstrap ValueEvent may intentionally omit canonical foreign coordinates so it remains concurrent with independently-existing legacy value. Its stored context is still a closed cut over coordinates it includes.

## Information join

For compatible causally closed prefix journals J and K at one current database version:

```text
J join K = immutable prefix union
```

with componentwise max frontier and actual records retained through every coordinate.

Then join is idempotent, commutative, and associative for mutually compatible histories.

The join never rewrites a record.

## Replay is deterministic, not fieldwise join

`project(J)` is deterministic, but `project(J join K)` is not required to be fieldwise merge of `project(J)` and `project(K)`.

Union can select another occurrence, change strongest certificate, reveal invalidation, make dependents stale, or require explicit structural normalization.

## Information growth versus semantic state

Within one version, ordinary authoring, synchronization, and reset are monotone in retained information, but projection is not monotone in presence/freshness/value terms.

## Causal relation versus total authority

`happenedBefore` is transitive partial causal order. `authorityCompare` is deterministic total conflict-precedence order extending it.

Coverage rules use causal order, not merely authority.

## Certificate proof order

For eligible certificates targeting one current ValueId, replay chooses lexicographically by:

```text
basisMatchCount
coversValueInvalidations
then authority
```

Authority resolves only remaining tie.

This order has a lifecycle consequence: a later weaker certificate cannot necessarily supersede an older stronger certificate merely by having later authority.

## Maintenance proof weakening is negative authority over certificates

When reset/migration must remove a validity edge while preserving the value occurrence, it first appends node-scoped invalidation and only then target certificate.

The invalidation does not delete old certificate. Instead it changes eligibility: every older certificate which did not observe barrier is excluded from current proof selection.

Thus retained information remains monotone while projected validity can become strictly weaker.

## Persistent freshness is separate from recursive freshness

A node can currently be stale only because an input is stale even though its own proof is complete.

If graph semantics store that stale transition persistently, synchronization/reset/migration record value-scoped invalidation for exact occurrence. Otherwise later upstream `Unchanged` could erase stale flag without dependent validation.

Therefore “currently replayed stale” and “persistently stale in history” are distinct concepts.

## Normalization is semantic authoring, not pure join

Synchronization may append receiver-authored `DeleteEvent(reason="sync")` and value-scoped `InvalidateEvent(reason="sync")` when combined history creates real graph transition that must persist.

These are immutable semantic events, not temporary merge annotations.

Therefore normalization is operational relative to one actual receiver execution rather than pure function only of eventual raw set of imported records.

## Convergence is not counterfactual confluence

Raw compatible history union is order-independent.

Different synchronization schedules may commit different real normalization events before all concurrent facts are observed. Journal 3 requires every actual fair supported execution to reach finite normalization fixed point after non-normalization graph changes stop; it does not require counterfactual executions to author identical history.

## Why normalization terminates after quiescence

After quiescence synchronization creates no ValueEvent or ValidateEvent, only negative repairs. With finite pre-existing positive history and finite schema DAG, only finitely many repair obligations arise.

## Reset is monotone history plus semantic repair

Reset does not replace receiver history with source history.

Conceptually:

```text
J0 = Jreceiver join Jsource
Jafter = J0 + required reset events
```

If J0 already selects requested occurrence, reset preserves its ValueId. When target proof is weaker, a node-scoped proof barrier excludes older stronger certificates before target certificate is authored. When target stores persistent stale state but recursive replay is already stale through an input, reset still records value-scoped stale marker if own proof is otherwise complete.

Target absence gets DeleteEvent exactly when J0 currently selects value.

Reset repairs deliberately happen after J0 and therefore dominate observed state where required.

## Canonical initial bootstrap is frozen cut plus historical merge

Pre-Journal replicas have no pre-existing ValueIds.

A cohort establishes one canonical semantic bootstrap basis for occurrences equal to canonical cut. Artifact is frozen at creator exact bootstrap frontier/target version-schema before ordinary Journal history begins.

A joining installation does **not** reset that cut to its legacy cache.

Instead:

- equal occurrences reuse canonical ValueIds;
- different/local-only occurrences become historical joining-writer bootstrap ValueEvents;
- divergent values are concurrent unless genuine pre-Journal causality says otherwise;
- authority is seeded from legacy `modifiedAt`;
- canonical presence plus local absence creates no DeleteEvent;
- proof/freshness evidence is added after values.

Two independent joiners can assign distinct ValueIds to same non-canonical occurrence. This accepted identity split is `$id-1635227135166767`.

## Creator resume is identity continuation, not merge

If canonical artifact became durable but creator crashed before local cutover, restart with same local fingerprint may install exact artifact without authoring new history only if local legacy target still equals artifact projection.

This is neither ordinary same-writer Journal recovery nor foreign bootstrap join. Semantic mismatch is bootstrap fork because lifecycle cannot safely claim artifact and mutable legacy state are one continuing history.

## Bootstrap artifact is not current history and compatibility is bounded

Let `B.bootstrapFrontier = F0` and let creator later author history through F1>F0.

Bootstrap joining uses only records through F0, never F1.

A running release may interpret B only when B target version/schema equals release's expected bootstrap target. The algebra does not impose permanent compatibility with old artifact formats or migration ladders on future releases.

Post-bootstrap current history arrives later through ordinary synchronization once installation reaches compatible current version through whatever explicit migrations its software supports.

## Migration representation is not same-version join

A format-changing migration first applies deterministic recordwise transformation:

```text
Jconverted = rewriteJournalFormat(Jbefore, sourceVersion, targetVersion)
```

preserving every old JournalRecordId and historical semantic/causal/reference fact.

Same-version `<=`/join relation is not applied across two physical representations.

## Record-format migration is function of record

For fixed source->target migration definition, each retained record has one canonical target representation.

If ValueEvent payload representation changes, rewrite is independent of selection, other local records, and callback-local state.

That prevents two replicas retaining same immutable JournalRecordId from migrating into different target bodies and later appearing forked.

## `override()` is representation change, not occurrence change

The migration contract defines `override()` as semantic-preserving.

Target bytes for selected occurrence V come from canonical per-record codec. Override callback asserts its result equals codec output; it does not make V body replica-dependent.

ValueId, semantic value, NodeIdentifier, timestamps, and causal identity remain unchanged.

## Migration preserves occurrence identity when semantics preserve occurrence

`keep`, `override`, `invalidate`, schema-only, proof-only, and freshness-only changes preserve selected ValueId when semantic cached occurrence survives.

Proof/freshness may nevertheless change via node/value invalidations and validations as required above.

## Genuine replacement migration may split identity

If migration genuinely creates/replaces semantic occurrence, independently migrating replicas may author different new ValueIds.

When histories later join, ordinary authority selects current occurrence. A dependent certificate naming losing replacement may stop matching and make dependent stale until revalidated/recomputed.

This is accepted migration trade-off. Journal-aware migration does not require remote canonical migration participant.

## Derived state is outside retained-history algebra

Materialized graph sublevels, indexes, checkpoints, staging replicas, transport branches/cursors, and cached validation summaries are not authoritative Journal elements.

Canonical-bootstrap artifact is lifecycle source state rather than active current JournalReplica.

Derived state may be created/deleted/rebuilt without changing retained semantic history, subject to atomic cutover and replay equivalence.
