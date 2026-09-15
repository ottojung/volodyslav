# IncrementalGraph Journal 3 Worked Traces

## Purpose

These traces are explanatory tests of the normative Journal 3 rules. Normative specifications win if a trace ever disagrees with them.

Exact HLC values, full contexts, identifiers, and timestamps are omitted where not relevant.

## Trace 1: first materialization

Writer X pulls absent A and computes `a1`:

```text
X:1 Value(A,payload=a1)
X:2 Validate(A,value=X:1,basis=[])
```

Projection: A is present and fresh.

## Trace 2: changed recomputation propagates persistent staleness

Before:

```text
A=X:1 fresh
B=X:3 fresh, basis [{input:A,value:X:1}]
```

A changes:

```text
X:5 Value(A,payload=a2)
X:6 Validate(A,value=X:5,basis=[])
X:7 Invalidate(B,scope=value(X:3),reason=propagated)
```

Projection: A fresh at X:5; B keeps cached X:3 but is stale.

## Trace 3: explicit invalidate then Unchanged

```text
X:7 Invalidate(A,scope=node,reason=explicit)
X:8 Invalidate(B,scope=value(B1),reason=propagated)
```

Later A returns `Unchanged`:

```text
X:9 Validate(A,value=A1,basis=[])
```

A becomes fresh. B remains stale until B itself validates/recomputes because X:8 remains uncovered for B1.

## Trace 4: concurrent values

```text
X:20 Value(A,payload=x,modifiedAt=10:00)
Y:14 Value(A,payload=y,modifiedAt=10:01)
```

The events are concurrent. Deterministic authority selects Y:14. Payload equality is irrelevant.

## Trace 5: causality beats physical time

X authors authority `(100,0)`. Y observes X but has wall/modified seed 90. Y must allocate after observed high-water, e.g. `(100,1)`, so X happened-before Y implies lower authority.

## Trace 6: malformed future/concurrent reference

```text
X:5 Validate(B,value=B1,basis=[{input:A,value:Y:9}])
Y:9 Value(A,...)
```

If X:5's context did not observe Y:9, validation is malformed even if Y:9 later appears in retained union.

## Trace 7: malformed non-transitive context

```text
A:1
B:1 context={A:1}
C:1 context={B:1,A:0}
```

C:1 is malformed because it includes B:1 but omits A:1, which B:1 had already observed.

## Trace 8: malformed own-writer context

```text
A:1 context={X:1}
A:2 context={A:0,X:0}
```

A:2 is malformed because its own-writer context must equal 1 and transitively include X:1.

## Trace 9: newly-selected dependent becomes persistently stale

```text
A -> B
```

Receiver X has `A=a1 stale`. Source Y supplies `B=b2 fresh` with certificate `{A:a1}`.

After union B=b2 is selected on X, but A is stale, so sync authors:

```text
X:n Invalidate(B,scope=value(b2),reason=sync)
```

If A later revalidates `Unchanged`, B remains stale until B itself validates/recomputes.

## Trace 10: source deletes an input

```text
A -> B -> C
```

A remote DeleteEvent wins for A. Sync authors explicit dependency closure:

```text
X:n   Delete(B,reason=sync)
X:n+1 Delete(C,reason=sync)
```

Old B/C ValueEvents remain historical but cannot silently reappear.

## Trace 11: repeat synchronization

After all source history and required normalization are incorporated, syncing the unchanged source again produces `changed=false`, no new semantic records, and the same projection.

## Trace 12: exact same-writer prefix recovery

Local A has `A:1..100`; controlled source has agreeing `A:1..120`. Import `A:101..120`, reconstruct writer state, then continue after A:120. Any overlap disagreement is a fork.

## Trace 13: certificate selection prefers invalidation coverage

Current K occurrence is V. R2 authors value invalidation I then complete validation C2 causally after I. Concurrent R1 authors equally matching C1 with greater total authority but without observing I.

Because C2 covers the invalidation and C1 does not, C2 wins before authority is consulted.

## Trace 14: competing partial certificates never combine

K has inputs A/B and current values A2/B2:

```text
C1=[{A:A2},{B:B1}]
C2=[{A:A1},{B:B2}]
```

Each matches one input. Replay chooses one certificate and never fabricates `{A:A2,B:B2}` by combining them.

## Trace 15: historical old-schema certificate remains intelligible

Old K inputs A/B with certificate `{A:A1,B:B1}`. New schema uses A/C. Old certificate remains historical evidence but is not current-shape-compatible; migration may preserve K's ValueId while authoring a new A/C validation for that same occurrence.

## Trace 16: value-scoped invalidation dies with the occurrence

K1 is stale due to `Invalidate(value=K1)`. Later new K2 wins. The old K1 marker remains history but does not stale K2.

## Trace 17: receiver-less absent-state restore

No local database exists. The configured installation recovery source yields snapshot S with localWriter A. Startup restores A's history/allocator/projection and then runs migration gate if needed. Query failure does not generate a fresh fingerprint B.

## Trace 18: canonical bootstrap source decision

Legacy host X reaches the Journal bootstrap gate.

- if cohort bootstrap source returns `Exists(B)`, B is an immutable `CanonicalBootstrapSnapshot` and X must join B;
- if it returns `DefinitelyAbsent`, X may create canonical bootstrap;
- if it returns indeterminate/error, X fails without creating history.

A source which cannot safely distinguish concurrent first creators must not return definite absence to both.

The creator freezes B at the exact frontier after bootstrap before any ordinary Journal operation.

## Trace 19: frozen bootstrap cut prevents stale-host rollback

At T0 canonical creator C bootstraps:

```text
K = v1
```

and freezes canonical artifact B at that frontier.

Later ordinary Journal history on C contains:

```text
C:x Value(K,v2)   // replaces v1
C:y Value(N,n1)   // new node N
```

Legacy host J has been offline since before T0 and still has:

```text
K = v1
N absent
```

J's bootstrap source returns B, **not C's current Journal snapshot**.

Therefore:

```text
Pc = K=v1
Gl = K=v1
```

J reuses canonical K's ValueId and authors no replacement for K. N is not in B, so J authors no delete for N.

J completes bootstrap at B's target version, runs any required Journal-aware migrations, and later ordinary synchronization imports C:x/C:y.

Final result selects K=v2 and N=n1. The offline host did not turn stale v1 into a causally newer write and did not delete a node created after bootstrap.

## Trace 20: divergent legacy values remain concurrent

Canonical bootstrap cut contains:

```text
C:K = c2, modifiedAt=T2
```

Late legacy J contains a genuinely different occurrence:

```text
J legacy K = j1, modifiedAt=T1
T1 < T2
```

J must preserve the fact that j1 did not observe C:K. It authors historical bootstrap ValueEvent J:K with:

```text
context[C] = 0
physical authority = T1
```

while C:K has authority seeded from T2.

The two occurrences are concurrent, so normal authority selects c2. J's later upgrade time does not make j1 win.

If instead J's legacy occurrence has `modifiedAt=T3 > T2`, the same concurrent construction lets J's value win for the ordinary timestamp-based reason.

## Trace 21: canonical presence is not deleted by legacy absence

Canonical bootstrap cut contains materialized K. Late legacy J does not have K materialized.

J authors no DeleteEvent for K merely to make the Journal projection equal its old cache. Pre-Journal absence is not timestamped deletion evidence. K remains materialized from the canonical side.

Conversely, a local-only materialized K receives a J-authored historical bootstrap ValueEvent and survives the join.

## Trace 22: late host joins old bootstrap version then migrates

Canonical bootstrap artifact B was created at database version N. The active cohort later migrated to N+1.

A legacy host joining years later still receives B encoded at N:

```text
B.databaseVersion = N
```

It joins B at N, then runs the supported N->N+1 Journal-aware migration locally. Only after reaching N+1 does it synchronize against current cohort snapshots.

A current N+1 JournalSnapshot is not substituted for B. If the supplied canonical artifact does not match the expected bootstrap target version/schema, join fails before authoring history.

## Trace 23: representation-only override preserves ValueId without record fork

Replicas X and Y both retain historical ValueEvent:

```text
V=(A,5)
payload=oldEncoding(x)
```

X currently selects V. Y has a later replacement for K, so V is historical there.

The version migration defines pure codec:

```text
rewriteValuePayload(V) = newEncoding(x)
```

Both replicas rewrite V identically whether or not V is selected.

On X, migration callback may call:

```text
override(K, () => newEncoding(x))
```

but this only asserts that the selected result equals the codec output. It does not supply V's bytes independently.

After migration X and Y still retain the same target body for JournalRecordId V. Later synchronization cannot fail with a fork for V.

If X's callback returned some replica-dependent `otherEncoding(x)` unequal to the codec output, X's migration would fail before cutover.

## Trace 24: independent genuine replacement migration may stale dependent

Before migration two replicas share:

```text
A=A1
B=B1, certificate [{A:A1}]
```

A semantic migration genuinely replaces A. Replicas migrate independently:

```text
X creates A2x
Y creates A2y
```

After X/Y synchronize, ordinary authority selects one A2 occurrence, say A2y. A certificate authored on X against A2x no longer matches the selected input. B may therefore become stale and later revalidate/recompute.

This is accepted. No canonical migration participant is required.

## Trace 25: occurrence-preserving migration

A version bump changes schema/proof/freshness but keeps semantic A/B occurrences. Migration preserves A1/B1 and may append new validation/invalidation records targeting those same ValueIds.

Two independently migrated replicas therefore keep the shared occurrence identities.

## Trace 26: minimal reset preserves unaffected occurrences

Receiver/source union already selects A1/B1 and target has same value occurrences but different B proof/freshness. Reset preserves A1/B1 and authors only required B validation/invalidation.

If target requires a different A occurrence, reset creates new A ValueEvent; B may still keep B1 with a new certificate if B itself is unchanged.

## Trace 27: reset deletion is deterministic

If union has K present and target requires K absent, reset authors exactly one `Delete(K,reason=reset)`. If union already selects absence, no delete is authored.

This trace deliberately does not apply to pre-Journal bootstrap join.

## Trace 28: bootstrap stale node with partial proof

Legacy K has inputs A/B, is stale, and only A->K validity remains. Bootstrap records:

```text
Validate(K,value=K0,basis=[
  {input:A,value:A0},
  {input:B,value:"unknown"}
],reason=bootstrap)
Invalidate(K,scope=value(K0),reason=bootstrap)
```

Replay reproduces stale K with partial validity without inventing provenance.

## Trace 29: projection rebuild

Authoritative Journal is valid but a derived freshness record is damaged. Maintenance rebuilds graph from Journal. No semantic event is authored merely to repair derived state.

## Trace 30: synchronization normalization is real history

Receiver has fresh A/B. Source Y supplies winning delete of A; source Z has unseen concurrent higher-authority A2. If receiver synchronizes Y first it may correctly author `Delete(B,reason=sync)`. That delete remains real history even if Z later makes A present again.

A different counterfactual source order might have avoided that delete. Journal 3 guarantees convergence of each actual fair execution, not identical histories across executions which genuinely authored different normalization events.
