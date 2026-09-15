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

- if cohort bootstrap source returns `Exists(S)`, X must join S;
- if it returns `DefinitelyAbsent`, X may create canonical bootstrap;
- if it returns indeterminate/error, X fails without creating history.

A source which cannot safely distinguish concurrent first creators must not return definite absence to both.

## Trace 19: late host joins canonical bootstrap with local delta

Canonical host C already bootstrapped:

```text
A -> B
C journal selects A=C:A1, B=C:B1
```

Late legacy host J was offline. Its legacy state still has the same A but has a locally changed B:

```text
A == canonical A
B == local B2
```

J retains C's bootstrap records verbatim and projects them using localWriter J. It then applies minimal bootstrap delta:

```text
A keeps ValueId C:A1
J:n Value(B,payload=B2,reason=bootstrap)
J:n+1 Validate(B,value=J:n,basis=[{input:A,value=C:A1}],reason=bootstrap)
```

J preserves its own writer fingerprint and allocator watermark. Startup succeeds with J's local B2 while every unaffected canonical occurrence keeps C's ValueId.

If J differed only in B freshness/proof, it would append only bootstrap Validate/Invalidate records and keep C:B1.

## Trace 20: representation-only override preserves ValueId

A and B are synchronized before migration and share:

```text
K ValueId = V
payload = oldEncoding(x)
```

Both independently migrate with:

```text
override(K, () => newEncoding(x))
```

The migration contract says semantic value x is unchanged. Whole-history representation rewrite therefore rewrites record V into target format while preserving:

```text
ValueId V
NodeIdentifier
createdAt
modifiedAt
causal identity
```

After migration both replicas still select V. Later synchronization does not create a certificate mismatch merely because stored representation changed.

## Trace 21: independent genuine replacement migration may stale dependent

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

## Trace 22: occurrence-preserving migration

A version bump changes schema/proof/freshness but keeps semantic A/B occurrences. Migration preserves A1/B1 and may append new validation/invalidation records targeting those same ValueIds.

Two independently migrated replicas therefore keep the shared occurrence identities.

## Trace 23: minimal reset preserves unaffected occurrences

Receiver/source union already selects A1/B1 and target has same value occurrences but different B proof/freshness. Reset preserves A1/B1 and authors only required B validation/invalidation.

If target requires a different A occurrence, reset creates new A ValueEvent; B may still keep B1 with a new certificate if B itself is unchanged.

## Trace 24: reset deletion is deterministic

If union has K present and target requires K absent, reset authors exactly one `Delete(K,reason=reset)`. If union already selects absence, no delete is authored.

## Trace 25: bootstrap stale node with partial proof

Legacy K has inputs A/B, is stale, and only A->K validity remains. Bootstrap records:

```text
Validate(K,value=K0,basis=[
  {input:A,value:A0},
  {input:B,value:"unknown"}
],reason=bootstrap)
Invalidate(K,scope=value(K0),reason=bootstrap)
```

Replay reproduces stale K with partial validity without inventing provenance.

## Trace 26: projection rebuild

Authoritative Journal is valid but a derived freshness record is damaged. Maintenance rebuilds graph from Journal. No semantic event is authored merely to repair derived state.

## Trace 27: synchronization normalization is real history

Receiver has fresh A/B. Source Y supplies winning delete of A; source Z has unseen concurrent higher-authority A2. If receiver synchronizes Y first it may correctly author `Delete(B,reason=sync)`. That delete remains real history even if Z later makes A present again.

A different counterfactual source order might have avoided that delete. Journal 3 guarantees convergence of each actual fair execution, not identical histories across executions which genuinely authored different normalization events.