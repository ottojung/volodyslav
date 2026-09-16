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

After all source history and required normalization are incorporated, syncing unchanged source again produces `changed=false`, no new semantic records, and same projection.

## Trace 12: exact same-writer prefix recovery

Local A has `A:1..100`; controlled source has agreeing `A:1..120`. Import `A:101..120`, reconstruct writer state, then continue after A:120. Any overlap disagreement is a fork.

## Trace 13: certificate selection prefers invalidation coverage

Current K occurrence is V. R2 authors value invalidation I then complete validation C2 causally after I. Concurrent R1 authors equally matching C1 with greater total authority but without observing I.

Because C2 covers invalidation and C1 does not, C2 wins before authority is consulted.

## Trace 14: competing partial certificates never combine

K has inputs A/B and current values A2/B2:

```text
C1=[{A:A2},{B:B1}]
C2=[{A:A1},{B:B2}]
```

Each matches one input. Replay chooses one certificate and never fabricates `{A:A2,B:B2}` by combining them.

## Trace 15: historical old-schema certificate remains intelligible

Old K inputs A/B with certificate `{A:A1,B:B1}`. New schema uses A/C. Old certificate remains historical evidence but is not current-shape-compatible; migration may preserve K's ValueId while authoring a new A/C validation for that same occurrence.

## Trace 16: value-scoped invalidation dies with occurrence

K1 is stale due to `Invalidate(value=K1)`. Later new K2 wins. Old K1 marker remains history but does not stale K2.

## Trace 17: receiver-less absent-state restore

No local database exists. Configured installation recovery source yields snapshot S with localWriter A. Startup restores A's history/allocator/projection and then runs migration gate if needed. Query failure does not generate a fresh fingerprint B.

## Trace 18: canonical bootstrap source decision

Legacy host X reaches Journal bootstrap gate.

- `DefinitelyAbsent` -> X may create canonical bootstrap;
- `IndeterminateOrError` -> X fails without creating history;
- `Exists(B)` -> if B is incompatible with this release's expected bootstrap target, fail compatibility; otherwise choose creator-resume when `B.creatorWriter == localFingerprint`, ordinary join otherwise.

A source which cannot safely distinguish concurrent first creators must not return definite absence to both.

## Trace 19: frozen bootstrap cut prevents stale-host rollback

At T0 canonical creator C bootstraps `K=v1` and freezes artifact B.

Later C authors `K=v2` and new node N. Legacy J was offline and still has K=v1, N absent.

J's bootstrap source returns B, not C's current Journal snapshot. J reuses canonical K=v1 ValueId and authors no delete for N. Post-bootstrap v2/N can enter only later through ordinary compatible synchronization. Upgrade timing cannot turn stale v1 into a causally newer write.

## Trace 20: divergent legacy values remain concurrent

Canonical cut contains `K=c2, modifiedAt=T2`. Late legacy J has different `K=j1, modifiedAt=T1`.

J's bootstrap ValueEvent omits synthetic canonical causality and uses physical authority T1. Canonical and J values are concurrent, so c2 wins because T2>T1.

If J instead has T3>T2, J wins for the normal legacy timestamp reason—not because migration ran later.

## Trace 21: canonical presence is not deleted by legacy absence

Canonical cut has materialized K. Late legacy J lacks K. J authors no DeleteEvent merely to reproduce its old cache; pre-Journal absence is not timestamped deletion evidence. K survives.

Conversely, local-only materialized K receives a J-authored historical bootstrap ValueEvent.

## Trace 22: bootstrap compatibility is bounded

Canonical artifact B was created at bootstrap target N. A later software release no longer declares N/schemaN as its supported legacy bootstrap target.

A still-legacy host using that later release receives B but fails with `JournalVersionCompatibilityError` before authoring history.

Journal 3 does not require the later release to carry N's artifact decoder and complete N->current migration chain forever. The operator must first use software which explicitly supports N's bootstrap transition, then upgrade normally.

## Trace 23: creator resumes after artifact-publication crash

Legacy creator C receives `DefinitelyAbsent` and builds canonical artifact B. B becomes durable, then C crashes before local Journal cutover.

On restart C is still pre-Journal and has the same fingerprint as `B.creatorWriter`.

If interpreting C's local legacy database at B's target yields the same semantic graph as `project(B)`, creator-resume installs exactly B, reconstructs writer head/watermark/high-water/projection, and cuts over with **no duplicate bootstrap events**.

If local legacy semantics differ, creator-resume fails `JournalBootstrapForkError` and authors nothing.

## Trace 24: identical non-canonical late joiners may split ValueId

Canonical C has older K. Late joiners J1 and J2 previously synchronized with each other and both hold the same newer legacy K occurrence, identical in NodeIdentifier/payload/timestamps, but different from canonical K.

Each independently joins canonical artifact and authors its own historical bootstrap ValueEvent:

```text
J1:k != J2:k
```

although both represent the same legacy materialization.

Later synchronization selects one by normal authority/tie-break. A dependent certificate naming the losing bootstrap ValueId may stop matching and become stale.

This is accepted by `$id-1635227135166767`; canonical bootstrap guarantees shared identity for occurrences equal to canonical cut, not universal deduplication of all independently converted non-canonical legacy state.

## Trace 25: representation-only override preserves ValueId without record fork

Replicas X and Y both retain historical V=(A,5), but only X currently selects V. Version migration defines a pure per-record codec rewriting V's payload representation.

Both replicas rewrite V identically whether selected or historical. X's `override(K, ...)` only asserts its callback result equals codec output; it does not independently supply V's immutable bytes.

After migration X/Y retain same target body for V. A replica-local callback mismatch fails before cutover.

## Trace 26: independent genuine replacement migration may stale dependent

Before migration two replicas share A=A1 and B=B1 validated against A1. A semantic migration genuinely replaces A independently as A2x/A2y.

After synchronization one replacement wins. A dependent certificate naming losing A occurrence may become stale and later revalidate/recompute. This is accepted; no canonical migration participant is required.

## Trace 27: occurrence-preserving migration

A version bump changes schema/proof/freshness but keeps semantic A/B occurrences. Migration preserves A1/B1 and may append validation/invalidation records targeting those same ValueIds.

## Trace 28: migration proof barrier removes stronger old proof

```text
A -> B
before:
    A=a1
    B=b1
    C_old(B)={A:a1}
```

Migration explicitly invalidates B while preserving b1. Target has no A->B validity.

Appending only `{A:"unknown"}` would fail because old certificate has basisMatchCount 1 and new has 0. Therefore migration authors:

```text
M:n   Invalidate(B,scope=node,reason=migration)
M:n+1 Validate(B,value=b1,basis=[{A:"unknown"}],reason=migration)
```

C_old did not observe M:n and is now ineligible. New partial certificate establishes zero A->B validity exactly.

## Trace 29: migration persists propagated staleness

```text
A -> B
initial: A fresh; B fresh, certificate {A:a1}
migration: invalidate(A)
```

Target migration graph stores A stale and B stale by propagated flag while B retains complete `{A:a1}` proof.

After target proof repair, B's own proof is ready but replay is already stale recursively because A is stale. Migration still authors:

```text
Invalidate(B,scope=value(b1),reason=migration)
```

Later `pull(A) -> Unchanged` may freshen A, but B remains stale until B validates/recomputes.

## Trace 30: reset proof barrier removes receiver-only proof

Receiver/source union selects same A/B occurrences, but receiver has full A->B validity while reset target has no A->B validity.

Reset authors node-scoped B proof barrier before target partial/all-unknown validation. Old full certificate becomes ineligible and final reset projection really removes A->B.

## Trace 31: reset persists target propagated staleness

Reset target stores A stale and B stale with B's full proof intact. After Pass 2 B's own proof is complete, so reset ensures an uncovered value-scoped invalidation targets final B ValueId even if B is currently recursively stale through A.

Later `A -> Unchanged` does not freshen B.

## Trace 32: minimal reset preserves unaffected occurrences

Receiver/source union already selects A1/B1 and target has same value occurrences but different B proof/freshness. Reset preserves A1/B1 and authors only required barrier/validation/invalidation records.

If target requires different A occurrence, reset creates new A ValueEvent; B may keep B1 with new proof if B itself unchanged.

## Trace 33: reset deletion is deterministic

If union has K present and target requires K absent, reset authors exactly one `Delete(K,reason=reset)`. If union already selects absence, no delete is authored.

This trace deliberately does not apply to pre-Journal bootstrap join.

## Trace 34: bootstrap stale node with partial proof

Legacy K has inputs A/B, is stale, and only A->K validity remains. Bootstrap records partial certificate with A known/B unknown followed by value-scoped bootstrap invalidation. Replay reproduces stale K with partial validity without inventing provenance.

## Trace 35: projection rebuild

Authoritative Journal is valid but derived freshness record is damaged. Maintenance rebuilds graph from Journal. No semantic event is authored merely to repair derived state.

## Trace 36: synchronization normalization is real history

Receiver has fresh A/B. Source Y supplies winning delete of A; source Z has unseen concurrent higher-authority A2. If receiver synchronizes Y first it may correctly author `Delete(B,reason=sync)`. That delete remains real history even if Z later makes A present again.

A different counterfactual source order might have avoided that delete. Journal 3 guarantees convergence of each actual fair execution, not identical histories across executions which genuinely authored different normalization events.
