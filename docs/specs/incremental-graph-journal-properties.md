# IncrementalGraph Journal 3 Algebraic Properties

## Purpose

Journal 3 separates:

1. same-version retained-information union;
2. deterministic projection/normalization;
3. database-format migration; and
4. explicit lifecycle transitions which may author semantic history.

These layers have different algebraic behavior and must not be conflated.

## Same-version retained-information order

For compatible retained journals J and K in one current database format, define:

```text
J <= K
```

iff every writer prefix in J is a prefix of the same writer in K and every overlapping record has identical canonical meaning.

If overlapping content differs, the journals are not compatible under this relation; that is a writer fork/corruption condition.

## Causally closed prefix journals

A supported semantic-event context is a causally closed frontier.

For F=(W,q):

```text
F.context[W] == q - 1
```

and if F.context includes E then:

```text
E.context <= F.context
```

componentwise.

Therefore the direct context/same-writer definition of `happenedBefore` is transitive.

This closure is essential to the algebra below: a numerical prefix containing malformed non-closed event contexts is not a supported Journal element merely because every referenced coordinate exists.

## Information join

For compatible causally closed prefix journals J and K at one current database version:

```text
J join K = immutable prefix union
```

with componentwise max frontier and actual records retained through every coordinate.

Then:

```text
J join J = J
J join K = K join J
(J join K) join L = J join (K join L)
```

for mutually compatible histories.

Because event contexts are closed cuts in the inputs, their agreeing prefix union remains causally closed.

The join never rewrites a record.

## Replay is deterministic, not a fieldwise join

`project(J)` is deterministic, but Journal 3 does not require:

```text
project(J join K)
```

to be a fieldwise merge of `project(J)` and `project(K)`.

Union can select another current occurrence, change the strongest certificate, reveal invalidation, make dependents stale, or require explicit structural normalization.

Those consequences are determined by replay/synchronization rules rather than graph-field algebra.

## Information growth versus semantic state

Within one version, ordinary authoring, synchronization, and reset are monotone in retained information:

```text
Jbefore <= Jafter
```

but projection is not monotone in presence/freshness/value terms:

- DeleteEvent can make a node absent;
- ValueEvent can replace current occurrence;
- InvalidateEvent can make a cached occurrence stale;
- a later covering ValidateEvent can make it fresh again.

Information growth describes semantic transitions; it does not mean “more present/fresh.”

## Causal relation versus total authority

`happenedBefore` is a transitive partial causal order.

`authorityCompare` is a deterministic total conflict-precedence order extending it:

```text
happenedBefore(E,F)
    => authorityCompare(E,F) < 0
```

Concurrent events remain historically concurrent even though authority chooses one deterministic order between them.

Coverage rules therefore use causal order, not merely authority.

## Certificate proof order

For eligible certificates targeting one current ValueId, replay chooses lexicographically by:

```text
basisMatchCount
coversValueInvalidations
then authority
```

This is not arbitrary clock preference: an equally matching certificate which causally covers the current occurrence's value invalidations carries stronger proof than a concurrent certificate which does not.

Authority resolves only the remaining tie.

## Normalization is semantic authoring, not pure join

Synchronization may append receiver-authored:

```text
DeleteEvent(reason="sync")
InvalidateEvent(reason="sync", scope=value(...))
```

when the newly combined history creates a real graph transition that must persist under IncrementalGraph semantics.

These are immutable semantic events, not temporary merge annotations.

Therefore normalization is operational relative to one actual receiver execution rather than a pure function only of an eventual raw set of imported records.

For an unchanged already-normalized receiver/source state:

```text
normalize(normalizedState, sameSourceFacts)
    = normalizedState
```

in the sense that no new semantic record is required.

## Convergence is not counterfactual confluence

Raw compatible history union is order-independent.

Different synchronization schedules may nevertheless commit different real normalization events before all concurrent facts are observed. Journal 3 does not require those counterfactual executions to have identical final histories/projections.

It requires every actual fair supported execution to reach a finite normalization fixed point after non-normalization graph changes stop.

## Why normalization terminates after quiescence

After quiescence synchronization creates no ValueEvent or ValidateEvent, only negative repairs:

```text
sync DeleteEvent
sync value-scoped InvalidateEvent
```

A delete can require another future repair only if previously unseen finite positive history later selects another occurrence.

A value-scoped invalidation fixes one exact occurrence stale and synchronization cannot clear it because clearing requires a validation.

With finite pre-existing positive history and finite schema DAG, only finitely many repair obligations arise.

## Reset is monotone history plus minimal semantic repair

Reset does not replace receiver history with source history.

Conceptually:

```text
J0 = Jreceiver join Jsource
Jafter = J0 + only required reset events
```

For a target-present K:

- if J0 already selects the requested immutable semantic occurrence, reset preserves its ValueId;
- if value state differs, reset may append a new ValueEvent;
- proof/freshness differences are represented with Validate/Invalidate history without changing ValueId unnecessarily.

Target absence gets a DeleteEvent exactly when J0 currently selects a value.

Thus reset is retained-information growth, but it does not create graph-wide duplicate occurrences merely to establish a target projection.

## Canonical initial bootstrap

Pre-Journal replicas in one synchronization cohort have no pre-existing ValueIds for their shared cached occurrences.

If they independently minted equivalent bootstrap ValueIds, later same-version union could split input/dependent heads across writers and invalidate certificates artificially.

The supported transition therefore produces one canonical semantic bootstrap history for the reconciled legacy state. Joining installations retain those same semantic records while preserving their own local writer/allocator state.

This establishes one occurrence identity basis before ordinary Journal union begins.

## Migration representation is not same-version join

A format-changing migration first applies a deterministic recordwise transformation:

```text
Jconverted = rewriteJournalFormat(Jbefore, sourceVersion, targetVersion)
```

preserving every old JournalRecordId and historical semantic/causal/reference fact.

The same-version `<=`/join relation is not applied across the two physical representations.

After rewrite, target semantic migration appends only required new semantic facts.

## Migration preserves occurrence identity when semantics preserve the occurrence

If target migration keeps K's current immutable occurrence fields, then:

```text
targetValueId(K) == sourceValueId(K)
```

Schema/proof/freshness change alone may append Validate/Invalidate events without changing that occurrence.

This property prevents database-version transitions from gratuitously turning one shared cached occurrence into unrelated per-host occurrences.

If migration truly creates/replaces semantic occurrences, a synchronization cohort retains one canonical semantic migration history for its reconciled source state rather than independently minting equivalent new ValueIds.

Occurrence-preserving / representation-only migration may run independently because existing shared identities remain shared.

## Derived state is outside the retained-history algebra

Materialized graph sublevels, indexes, checkpoints, staging replicas, transport branches/cursors, and cached validation summaries are not authoritative Journal elements.

They may be created/deleted/rebuilt without changing retained semantic history, subject to atomic cutover and replay equivalence.