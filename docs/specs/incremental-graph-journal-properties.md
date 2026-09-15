# IncrementalGraph Journal 3 Algebraic Properties

## Purpose

Journal 3 separates:

1. same-version retained-information union;
2. deterministic projection/normalization;
3. database-format migration; and
4. explicit lifecycle transitions which may author semantic history.

These layers have different algebraic behavior and must not be conflated.

## Same-version retained-information order

For compatible retained journals J and K in one current database format, define `J <= K` iff every writer prefix in J is a prefix of the same writer in K and every overlapping record has identical canonical meaning.

If overlapping content differs, the journals are not compatible under this relation; that is a writer fork/corruption condition.

## Causally closed prefix journals

A supported semantic-event context is a causally closed frontier.

For F=(W,q):

```text
F.context[W] == q - 1
```

and if F.context includes E then `E.context <= F.context` componentwise.

Therefore the direct context/same-writer definition of `happenedBefore` is transitive.

A historical bootstrap ValueEvent may intentionally omit canonical foreign coordinates so it remains concurrent with an independently-existing legacy value. Its stored context is still a closed cut over the coordinates it does include.

## Information join

For compatible causally closed prefix journals J and K at one current database version:

```text
J join K = immutable prefix union
```

with componentwise max frontier and actual records retained through every coordinate.

Then join is idempotent, commutative, and associative for mutually compatible histories.

The join never rewrites a record.

## Replay is deterministic, not a fieldwise join

`project(J)` is deterministic, but `project(J join K)` is not required to be a fieldwise merge of `project(J)` and `project(K)`.

Union can select another current occurrence, change the strongest certificate, reveal invalidation, make dependents stale, or require explicit structural normalization.

## Information growth versus semantic state

Within one version, ordinary authoring, synchronization, and reset are monotone in retained information, but projection is not monotone in presence/freshness/value terms.

## Causal relation versus total authority

`happenedBefore` is a transitive partial causal order. `authorityCompare` is a deterministic total conflict-precedence order extending it.

Coverage rules use causal order, not merely authority.

## Certificate proof order

For eligible certificates targeting one current ValueId, replay chooses lexicographically by:

```text
basisMatchCount
coversValueInvalidations
then authority
```

Authority resolves only the remaining tie.

## Normalization is semantic authoring, not pure join

Synchronization may append receiver-authored `DeleteEvent(reason="sync")` and value-scoped `InvalidateEvent(reason="sync")` when combined history creates a real graph transition that must persist.

These are immutable semantic events, not temporary merge annotations.

Therefore normalization is operational relative to one actual receiver execution rather than a pure function only of an eventual raw set of imported records.

## Convergence is not counterfactual confluence

Raw compatible history union is order-independent.

Different synchronization schedules may commit different real normalization events before all concurrent facts are observed. Journal 3 requires every actual fair supported execution to reach a finite normalization fixed point after non-normalization graph changes stop; it does not require counterfactual executions to author identical history.

## Why normalization terminates after quiescence

After quiescence synchronization creates no ValueEvent or ValidateEvent, only negative repairs. With finite pre-existing positive history and finite schema DAG, only finitely many repair obligations arise.

## Reset is monotone history plus minimal semantic repair

Reset does not replace receiver history with source history.

Conceptually:

```text
J0 = Jreceiver join Jsource
Jafter = J0 + only required reset events
```

If J0 already selects the requested semantic occurrence, reset preserves its ValueId. Proof/freshness differences are represented without changing ValueId unnecessarily. Target absence gets a DeleteEvent exactly when J0 currently selects a value.

Reset's authored repairs deliberately happen after J0 and therefore dominate the observed state where required.

## Canonical initial bootstrap is a frozen cut plus historical merge

Pre-Journal replicas have no pre-existing ValueIds for shared cached occurrences.

A cohort therefore establishes one canonical semantic bootstrap basis. The canonical artifact is frozen at the creator's exact bootstrap frontier and bootstrap target version/schema before ordinary Journal history begins.

A joining installation does **not** reset that cut to its legacy cache.

Instead:

- equal legacy occurrences reuse canonical ValueIds;
- genuinely different/local-only legacy occurrences become historical joining-writer bootstrap ValueEvents;
- divergent canonical/local values are concurrent unless genuine pre-Journal causality says otherwise;
- their authority is seeded from legacy `modifiedAt`, so upgrade execution time does not decide the conflict;
- canonical presence plus local absence creates no DeleteEvent because absence is not legacy deletion evidence;
- proof/freshness evidence is added after the value occurrences exist.

Thus the joining projection may differ from the joining host's old cache at a conflicting node. That is intentional: normal conflict authority, not “who upgraded last,” decides the value.

## Bootstrap artifact is not current history

Let `B.bootstrapFrontier = F0` and let C later author history through F1 > F0.

Bootstrap joining uses only:

```text
C through F0
```

not C through F1.

Therefore post-bootstrap value changes/creations cannot be reinterpreted as state which a stale pre-Journal host should overwrite/delete during bootstrap.

The artifact remains encoded under its bootstrap target version/schema even if active cohort replicas later migrate forward. It is lifecycle source state, not an active current JournalReplica.

A late host first joins at B's original bootstrap target version, then follows ordinary database migration to current version, then ordinary synchronization imports compatible post-bootstrap history.

## Migration representation is not same-version join

A format-changing migration first applies a deterministic recordwise transformation:

```text
Jconverted = rewriteJournalFormat(Jbefore, sourceVersion, targetVersion)
```

preserving every old JournalRecordId and historical semantic/causal/reference fact.

The same-version `<=`/join relation is not applied across the two physical representations.

## Record-format migration is a function of the record

For a fixed source->target migration definition, each retained record has one canonical target representation.

In particular, if a ValueEvent payload representation changes, the rewrite is independent of whether the ValueEvent is currently selected, what other records exist locally, and arbitrary callback-local state.

That property is required so two replicas retaining the same immutable JournalRecordId cannot correctly migrate into different target bodies and later appear forked.

## `override()` is representation change, not occurrence change

The existing migration contract defines `override()` as semantic-preserving.

Therefore if selected occurrence V is overridden from `oldEncoding(x)` to `newEncoding(x)`, the target-format rewrite changes the representation of record V but preserves:

```text
ValueId = V
semantic value = x
NodeIdentifier
createdAt
modifiedAt
causal identity
```

The target bytes for V come from the canonical per-record migration codec. The `override()` callback asserts that its selected result equals that codec output; it does not make V's body replica-dependent.

Two replicas independently applying the same representation migration therefore retain identical target V even when V is selected on only one of them.

## Migration preserves occurrence identity when semantics preserve the occurrence

`keep`, `override`, `invalidate`, schema-only changes, proof-only changes, and freshness-only changes preserve the selected ValueId when the semantic cached occurrence survives.

This prevents version transitions from gratuitously turning one shared occurrence into unrelated per-host occurrences.

## Genuine replacement migration may split identity

If migration genuinely creates/replaces a semantic occurrence, independently migrating replicas may author different new ValueIds.

When those histories later join, ordinary authority selects the current occurrence. A dependent certificate naming a losing replacement may stop matching and make that dependent stale until revalidated/recomputed.

This is an accepted migration trade-off. Journal-aware migration does not require a remote canonical migration participant.

## Derived state is outside the retained-history algebra

Materialized graph sublevels, indexes, checkpoints, staging replicas, transport branches/cursors, and cached validation summaries are not authoritative Journal elements.

The frozen canonical-bootstrap artifact is lifecycle source state rather than an active current JournalReplica.

Derived state may be created/deleted/rebuilt without changing retained semantic history, subject to atomic cutover and replay equivalence.
