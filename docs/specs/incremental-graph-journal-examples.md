# IncrementalGraph Journal 3 Worked Traces

## Purpose

These traces are explanatory tests of the normative Journal 3 rules. Normative specifications win if a trace ever disagrees with them.

Exact HLC values, full contexts, identifiers, and timestamps are omitted where not relevant.

## Trace 1: first materialization

Writer X pulls absent A and computes `a1`:

```text
X:1 Value(A, payload=a1)
X:2 Validate(A, value=X:1, basis=[])
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
X:5 Value(A, payload=a2)
X:6 Validate(A, value=X:5, basis=[])
X:7 Invalidate(B, scope=value(X:3), reason=propagated)
```

Projection: A fresh at X:5; B keeps cached X:3 but is stale.

## Trace 3: explicit invalidate then Unchanged

```text
X:7 Invalidate(A, scope=node, reason=explicit)
X:8 Invalidate(B, scope=value(B1), reason=propagated)
```

Later A returns `Unchanged`:

```text
X:9 Validate(A, value=A1, basis=[])
```

A becomes fresh. B remains stale until B itself validates/recomputes because X:8 is still uncovered for B1.

## Trace 4: concurrent values

```text
X:20 Value(A, payload=x, modifiedAt=10:00)
Y:14 Value(A, payload=y, modifiedAt=10:01)
```

The events are concurrent. Deterministic authority selects Y:14. Payload equality is irrelevant.

## Trace 5: causality beats physical time

X authors authority `(100,0)`. Y observes X but has wall/modified seed 90. Y must allocate after observed high-water, e.g. `(100,1)`, so X happened-before Y implies lower authority.

## Trace 6: malformed future/concurrent reference

```text
X:5 Validate(B, value=B1, basis=[{input:A,value:Y:9}])
Y:9 Value(A,...)
```

If X:5's context did not observe Y:9, the validation is malformed even if Y:9 later appears in retained union.

## Trace 7: malformed non-transitive context

```text
A:1

B:1
context = { A:1 }

C:1
context = { B:1, A:0 }
```

C:1 is malformed.

It includes B:1 but omits A:1, which B:1 had already observed. Without rejecting this context, the definitions would yield:

```text
A:1 happenedBefore B:1
B:1 happenedBefore C:1
A:1 !happenedBefore C:1
```

Journal 3 requires contexts to be causally closed, so this history never becomes supported.

## Trace 8: malformed own-writer context

```text
A:1 context={X:1}
A:2 context={A:0,X:0}
```

A:2 is malformed because:

```text
A:2.context[A] must equal 1
```

The exact prior own prefix also carries A:1's transitive observation of X:1.

## Trace 9: receiver-only/newly-selected dependent becomes persistently stale

```text
A -> B
```

Receiver X:

```text
A=a1 stale
```

Source Y:

```text
B=b2 fresh
certificate(B) = [{input:A,value:a1}]
```

After union B=b2 may be newly selected on X. Its certificate exactly matches current A=a1, but A is stale. Sync therefore authors:

```text
X:n Invalidate(B, scope=value(b2), reason=sync)
```

If A later revalidates `Unchanged`, A becomes fresh but B remains stale until B itself validates/recomputes.

## Trace 10: source deletes an input

```text
A -> B -> C
```

A remote DeleteEvent wins for A. Sync authors explicit dependency closure:

```text
X:n   Delete(B, reason=sync)
X:n+1 Delete(C, reason=sync)
```

Old B/C ValueEvents remain historical but cannot silently reappear.

## Trace 11: repeat synchronization

After all source history and required normalization are incorporated, syncing the unchanged source again produces:

```text
changed=false
no new semantic records
same projection
```

## Trace 12: exact same-writer prefix recovery

Local A has `A:1..100`; controlled source has agreeing `A:1..120`.

Import `A:101..120`, reconstruct writer head/watermark/high-water, then continue at A:121 or later. If local/source A:87 differ, fail as a fork.

## Trace 13: certificate selection prefers invalidation coverage

Current K occurrence is V; inputs are unchanged.

R2 authors:

```text
I  = Invalidate(K, scope=value(V))
C2 = Validate(K, value=V, full current basis)
```

with `I happenedBefore C2`.

Concurrently R1 authors:

```text
C1 = Validate(K, value=V, same full basis)
```

C1 does not observe I but has greater total authority because of clock skew.

Then:

```text
basisMatchCount(C1) == basisMatchCount(C2)
coversValueInvalidations(C1) == false
coversValueInvalidations(C2) == true
```

C2 is selected before authority is consulted. K is fresh.

A clock tie-break cannot resurrect an invalidation that a causally later complete validation actually covered.

## Trace 14: competing partial certificates never combine

K has inputs A/B and current values A2/B2.

```text
C1 = [{A:A2},{B:B1}]
C2 = [{A:A1},{B:B2}]
```

Each matches one input. Replay chooses one complete certificate by the selection key; it never fabricates `{A:A2,B:B2}` by combining them.

## Trace 15: historical old-schema certificate remains intelligible

Old K inputs A/B:

```text
C_old=[{A:A1},{B:B1}]
```

New schema uses A/C. C_old still unambiguously describes old proof, but is not current-shape-compatible. Migration may preserve K's ValueId while authoring a new A/C ValidateEvent for that same occurrence if the cached value itself was preserved.

## Trace 16: value-scoped invalidation dies with the occurrence

K1 is stale due to `Invalidate(value=K1)`. Later new K2 wins. The old K1 marker remains history but does not stale K2.

## Trace 17: receiver-less absent-state restore

No local database exists.

The configured installation recovery source yields snapshot S with:

```text
S.localWriter = A
S contains A:1..120 and required foreign history
```

Startup restores the local database with:

```text
localWriter = A
```

reconstructs A's allocator/writer state and projection, then runs the migration gate if needed.

If querying that source fails, startup fails. It does not generate a new fingerprint B and silently start fresh.

## Trace 18: canonical multi-host pre-Journal bootstrap

Legacy hosts X and Y previously synchronized:

```text
A -> B
```

They share the same legacy A occurrence. X has a later B modification.

If X/Y independently minted semantic bootstrap histories, later sync could choose A's bootstrap ValueId from Y and B's from X, making X's B certificate mismatch despite the legacy state having been valid.

Supported transition instead chooses/reconciles one canonical legacy state. Suppose X creates:

```text
X:1 Value(A,...)
X:2 Value(B,...)
...
```

Y joins by retaining **those exact semantic bootstrap records**. Y does not mint Y-authored copies of A/B. It keeps its own local writer identity Y and records only its own writer allocator state as needed.

Both hosts therefore use the same bootstrap ValueIds for shared A/B state. Later Journal synchronization cannot stale B merely because hosts independently invented duplicate baseline identities—they did not.

If Y's legacy semantic graph differs from the canonical target, automatic canonical join fails until that difference is explicitly reconciled/rebaselined.

## Trace 19: occurrence-preserving migration

Before migration:

```text
A=A1
B=B1, certificate [{A:A1}]
```

A version bump changes record representation and perhaps proof/schema metadata, but keeps A/B payloads, identifiers, createdAt, and modifiedAt unchanged.

Migration preserves:

```text
targetValueId(A)=A1
targetValueId(B)=B1
```

If target proof for B differs, migration may author:

```text
Validate(B, value=B1, target-schema basis, reason=migration)
```

without a new B ValueEvent.

Two independently representation-migrated hosts therefore retain the same A1/B1 occurrence identities and do not create artificial basis mismatch simply because a version changed.

## Trace 20: semantic migration creating new occurrence is canonical across cohort

Suppose migration truly transforms A's payload and therefore must create A2.

If two reconciled peers independently created X:A2 and Y:A2 for the same intended migration result, downstream shared certificates could split again.

The cohort therefore retains one canonical semantic migration record for A2. Other peers deterministically rewrite their old shared history and retain that same new migration occurrence rather than re-minting an equivalent one.

## Trace 21: minimal reset preserves unaffected occurrences

Receiver/source union P0 already selects:

```text
A=A1
B=B1
```

with source target PS having the same A/B payloads, identifiers, and timestamps, but B's proof/freshness differs.

Reset preserves:

```text
resetValueId(A)=A1
resetValueId(B)=B1
```

and authors only the required B validation/invalidation. It does not create new A/B ValueEvents merely because reset was requested.

If PS instead requires a different A occurrence, reset authors a new A ValueEvent. B may still keep B1 and receive a new certificate naming the reset A ValueId if B's own value state is unchanged.

## Trace 22: reset deletion is deterministic

If P0 currently has K present and PS requires K absent, reset authors exactly one `Delete(K,reason=reset)`.

If P0 already selects absence, reset authors no delete.

There is no alternate implementation strategy that produces a different history for the same case.

## Trace 23: bootstrap stale node with partial proof

Legacy K has inputs A/B, is stale, and only A->K validity remains.

Bootstrap records:

```text
Validate(
  K,
  value=K0,
  basis=[
    {input:A,value:A0},
    {input:B,value:"unknown"}
  ],
  reason=bootstrap
)
Invalidate(K,scope=value(K0),reason=bootstrap)
```

Replay reproduces stale K with A->K valid and B->K invalid without inventing missing historical provenance.

## Trace 24: projection rebuild

Authoritative Journal is valid but a derived freshness record is damaged. Maintenance rebuilds graph from Journal:

```text
materializedGraph == project(journal)
```

No semantic event is authored merely to repair derived state. Invalid Journal history causes rebuild failure instead of history mutation.

## Trace 25: synchronization normalization is real history

Receiver has fresh A/B. Source Y supplies a winning delete of A; source Z has unseen concurrent higher-authority A2.

If receiver synchronizes Y first it may correctly author `Delete(B,reason=sync)`. That delete remains real history even if Z later makes A present again.

A different counterfactual source order might have avoided that delete. Journal 3 guarantees convergence of each actual fair execution, not identical histories across executions which genuinely authored different normalization events.