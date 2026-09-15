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

## Canonical initial bootstrap plus local delta

Pre-Journal replicas have no pre-existing ValueIds for shared cached occurrences.

A cohort therefore establishes one canonical semantic bootstrap basis. The cohort-bootstrap-source decision chooses whether an installation joins an existing basis or is allowed to create the first one.

A joining installation need not be observationally identical to the canonical projection. It retains canonical history, then appends a local bootstrap delta using minimal reset-like rules to reproduce its supported legacy graph.

Consequently:

- unaffected equal occurrences share canonical ValueIds;
- local legacy differences survive as joining-writer semantic records;
- validity/freshness-only differences do not replace otherwise-equal occurrences.

This gives ordinary Journal union a shared identity basis without requiring all hosts to have reconciled before upgrade.

## Migration representation is not same-version join

A format-changing migration first applies a deterministic recordwise transformation:

```text
Jconverted = rewriteJournalFormat(Jbefore, sourceVersion, targetVersion)
```

preserving every old JournalRecordId and historical semantic/causal/reference fact.

The same-version `<=`/join relation is not applied across the two physical representations.

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

Two replicas independently applying the same deterministic representation migration retain shared V rather than minting V_A and V_B.

## Migration preserves occurrence identity when semantics preserve the occurrence

`keep`, `override`, `invalidate`, schema-only changes, proof-only changes, and freshness-only changes preserve the selected ValueId when the semantic cached occurrence survives.

This prevents version transitions from gratuitously turning one shared occurrence into unrelated per-host occurrences.

## Genuine replacement migration may split identity

If migration genuinely creates/replaces a semantic occurrence, independently migrating replicas may author different new ValueIds.

When those histories later join, ordinary authority selects the current occurrence. A dependent certificate naming a losing replacement may stop matching and make that dependent stale until revalidated/recomputed.

This is an accepted migration trade-off. Journal-aware migration does not require a remote canonical migration participant.

## Derived state is outside the retained-history algebra

Materialized graph sublevels, indexes, checkpoints, staging replicas, transport branches/cursors, and cached validation summaries are not authoritative Journal elements.

They may be created/deleted/rebuilt without changing retained semantic history, subject to atomic cutover and replay equivalence.