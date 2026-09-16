# IncrementalGraph Journal 3 Worked Traces

## Purpose

These traces are explanatory tests of normative Journal 3 rules. Normative specifications win if a trace ever disagrees.

Exact HLC values, full contexts, identifiers, and timestamps are omitted where irrelevant.

## Trace 1: first materialization

```text
X:1 Value(A,payload=a1)
X:2 Validate(A,value=X:1,basis=[])
```

A is present and fresh.

## Trace 2: changed recomputation propagates persistent staleness

Before A=X:1 fresh and B=X:3 fresh against A=X:1. A changes:

```text
X:5 Value(A,payload=a2)
X:6 Validate(A,value=X:5,basis=[])
X:7 Invalidate(B,scope=value(X:3),reason=propagated)
```

B retains cached X:3 but is persistently stale.

## Trace 3: explicit invalidate then Unchanged

```text
X:7 Invalidate(A,scope=node,reason=explicit)
X:8 Invalidate(B,scope=value(B1),reason=propagated)
X:9 Validate(A,value=A1,basis=[])
```

X:9 covers A's node invalidation, so A becomes fresh. B remains stale because X:8 still applies to B1.

## Trace 4: concurrent values

```text
X:20 Value(A,x,modifiedAt=10:00)
Y:14 Value(A,y,modifiedAt=10:01)
```

They are concurrent. Authority selects Y:14. Payload equality is irrelevant.

## Trace 5: causality beats physical time

X has authority `(100,0)`. Y causally observes X but has physical seed 90. Y allocates after observed high-water, e.g. `(100,1)`, preserving happened-before -> authority order.

## Trace 6: malformed future/concurrent reference

```text
X:5 Validate(B,value=B1,basis=[{input:A,value:Y:9}])
Y:9 Value(A,...)
```

If X:5 did not causally observe Y:9, the validation is malformed even if Y:9 later appears in retained union.

## Trace 7: malformed non-transitive context

```text
A:1
B:1 context={A:1}
C:1 context={B:1,A:0}
```

C:1 is malformed because it includes B:1 while omitting A:1 which B:1 observed.

## Trace 8: malformed own-writer context

```text
A:1 context={X:1}
A:2 context={A:0,X:0}
```

A:2 is malformed: own-writer context must equal 1 and include X:1 transitively.

## Trace 9: newly-selected dependent becomes persistently stale

Receiver X has `A=a1 stale`. Source Y supplies fresh B=b2 validated against A=a1.

After union B=b2 is selected but stale only through A, so sync authors:

```text
X:n Invalidate(B,scope=value(b2),reason=sync)
```

Later A `Unchanged` does not freshen B.

## Trace 10: source deletes an input

For `A -> B -> C`, winning absence of A causes explicit sync deletion closure:

```text
Delete(B,reason=sync)
Delete(C,reason=sync)
```

Historical B/C values remain retained but cannot silently reappear.

## Trace 11: repeat synchronization

After source history and normalization are incorporated, syncing unchanged source again produces no records and no projection change.

## Trace 12: exact same-writer prefix recovery

Local A has A:1..100; controlled source has agreeing A:1..120. Import 101..120, rebuild writer state, continue after 120. Overlap disagreement is a fork.

## Trace 13: certificate selection prefers invalidation coverage

C2 causally covers value invalidation I for current V. Concurrent C1 has same full basis and greater authority but does not observe I. C2 wins because coverage is compared before authority.

## Trace 14: competing partial certificates never combine

```text
C1=[{A:A2},{B:B1}]
C2=[{A:A1},{B:B2}]
```

Replay chooses one certificate; it never synthesizes `{A:A2,B:B2}`.

## Trace 15: historical old-schema certificate remains intelligible

Old K certificate names inputs A/B. New schema uses A/C. Old certificate remains history but is not current-shape-compatible. Migration may preserve K ValueId while establishing A/C proof.

## Trace 16: value-scoped invalidation dies with occurrence

K1 is stale due to `Invalidate(value=K1)`. Later K2 wins. K1 marker remains history but does not stale K2.

## Trace 17: receiver-less absent-state restore

No local database exists. Recovery source yields snapshot S with localWriter A. Startup restores A history/allocator/projection. Query failure does not generate fresh writer B.

## Trace 18: canonical bootstrap source decision

Legacy X reaches bootstrap gate:

- `DefinitelyAbsent` -> may create canonical artifact;
- `IndeterminateOrError` -> fail without creation;
- `Exists(B)` -> validate exact expected bootstrap target; choose creator-resume iff creator writer equals local pre-Journal fingerprint, otherwise ordinary join.

## Trace 19: bootstrap is graph-semantic identity

Persisted pre-Journal graph contains K with:

```text
NodeIdentifier=k7-X
payload=v
createdAt=T0
modifiedAt=T1
freshness=...
validity=...
```

Canonical bootstrap journals those exact facts. It does not invoke an ordinary migration callback first.

Suppose a proposed legacy -> bootstrap-target path would call current `MigrationStorage.create()` for N. That operation would allocate a host-local identifier and execution-time timestamps. Such a path is rejected with `JournalVersionCompatibilityError` before bootstrap history is authored.

If N genuinely belongs in a later schema, bootstrap first establishes Journal identity for the persisted legacy graph; then Journal-aware migration may create N as a real migration occurrence.

## Trace 20: creator resumes without rerunning migration

Creator C publishes canonical artifact B and crashes before local cutover.

On restart C remains pre-Journal with `C.fingerprint == B.creatorWriter` and unchanged persisted legacy graph.

Creator-resume compares that persisted graph directly to `project(B)`, installs B exactly, reconstructs writer/allocator/high-water/projection, and cuts over. It does not rerun a callback or regenerate timestamps/identifiers.

If persisted legacy semantics changed, resume fails `JournalBootstrapForkError`.

## Trace 21: frozen bootstrap cut prevents stale-host rollback

Bootstrap artifact contains K=v1. Creator later writes K=v2 and creates N. Offline legacy J still has v1 and no N.

J joins only frozen artifact, reuses canonical v1 identity, and creates no delete for N. Later compatible ordinary sync imports v2/N. Upgrade timing cannot make stale v1 a newer write.

## Trace 22: divergent legacy values remain concurrent

Canonical has K=c2 at T2. Late J has different K=j1 at T1. J's historical bootstrap ValueEvent omits synthetic canonical causality and uses T1 authority. c2 wins because T2>T1, not because creator upgraded first.

If J has T3>T2, J wins for the normal modifiedAt reason.

## Trace 23: canonical presence is not deleted by legacy absence

Canonical cut has K; late legacy J lacks K. J authors no DeleteEvent merely to recreate its cache. Conversely local-only K gets historical joining ValueEvent.

## Trace 24: exact shared canonical stale cannot be freshened by join

Canonical cut contains exact shared occurrence V of K:

```text
C1 = Validate(K,V,full basis)
I  = Invalidate(K,scope=value(V),reason=bootstrap)
```

so canonical K is stale.

Joining legacy host has the exact same occurrence V but marks it fresh with complete local proof.

Join reuses V but **does not author a joining ValidateEvent merely to strengthen the shared occurrence's proof**. It preserves/ensures an uncovered value-scoped bootstrap invalidation for V because one side was stale.

Therefore migration execution cannot produce a causally-later C2 which covers I and accidentally freshens K. Exact shared stale merge is symmetric:

```text
joined stale = canonical stale OR joining stale
```

## Trace 25: joining stale shared input persistently stales canonical dependent

```text
D -> K
canonical cut:
    D=Dc fresh
    K=Kc fresh, certificate {D:Dc}
joining legacy:
    same D occurrence Dc stale
    K absent (or different K loses authority)
```

Pass J2 persists stale Dc. Kc remains selected and has complete own proof, so replay now reports K stale only recursively through D.

Pass J2b therefore authors:

```text
Invalidate(K,scope=value(Kc),reason=bootstrap)
```

Later `pull(D) -> Unchanged` may freshen D. K remains stale until K itself validates/recomputes.

## Trace 26: identical non-canonical late joiners may split ValueId

Canonical C has older K. J1/J2 both hold same newer non-canonical legacy K, but independently join and author J1:k and J2:k. Later authority selects one; dependent certs naming loser may stale. This is accepted by `$id-1635227135166767`.

## Trace 27: bounded bootstrap compatibility

A future release which no longer supports artifact B's bootstrap target rejects B with `JournalVersionCompatibilityError` before authoring. Journal 3 does not require an eternal decoder/migration ladder.

## Trace 28: representation-only override preserves ValueId

X/Y retain historical V, selected only on X. Pure format codec rewrites V identically on both. X's `override()` callback merely asserts selected result equals codec. Different replica-local output fails before cutover; no JournalRecordId fork is created.

## Trace 29: independent genuine replacement migration may stale dependent

X/Y share A1/B1; migration genuinely replaces A independently as A2x/A2y. After union one wins; dependent proof naming losing A occurrence may stale/recompute. Accepted; no canonical migration participant required.

## Trace 30: occurrence-preserving migration

A version bump changes schema/proof/freshness but retains semantic A/B occurrences. A1/B1 ValueIds remain; migration appends only required proof/freshness history.

## Trace 31: proof barrier weakens one occurrence without tainting another

Before migration current B occurrence is B1 with full `{A:A1}` proof. Maintenance target keeps B1 but removes A->B validity.

Appending only `{A:"unknown"}` is insufficient because old certificate has greater basisMatchCount. Migration authors:

```text
M:n   Invalidate(B,scope=proof(B1),reason=migration)
M:n+1 Validate(B,value=B1,basis=[{A:"unknown"}],reason=migration)
```

Old B1 certificate is ineligible; target has no A->B edge.

Now suppose another replica concurrently created B2 and validated B2 without observing M:n. After histories meet, M:n does **not** make B2's certificate ineligible because the barrier names B1 only.

## Trace 32: explicit migration invalidate remains node-scoped

If migration explicitly calls `invalidate(B)`, that is not merely maintenance proof weakening. It authors:

```text
Invalidate(B,scope=node,reason=migration)
```

A certificate which did not causally observe this actual node invalidation cannot clear it, even if that certificate targets another concurrent occurrence.

## Trace 33: migration persists propagated staleness

`A -> B`, initially both fresh with B proof `{A:a1}`. Migration explicitly invalidates A. Target graph has A stale and B persistently stale while B proof remains complete.

Migration still authors `Invalidate(B,scope=value(b1),reason=migration)` even though B is recursively stale at cut. Later `A -> Unchanged` does not freshen B.

## Trace 34: reset proof barrier removes receiver-only proof

Receiver/source union selects same A/B occurrences but receiver has full A->B validity while reset target does not.

Reset authors `Invalidate(B,scope=proof(B1),reason=reset)` before target partial validation. Old B1 full certificate becomes ineligible. A concurrent/later B2 certificate is not tainted by B1's barrier.

## Trace 35: reset persists target propagated staleness

Reset target stores A stale and B stale with complete B proof. Reset ensures value-scoped marker for final B ValueId even if replay is already recursively stale through A. Later `A -> Unchanged` does not freshen B.

## Trace 36: reset deletion is deterministic

If union selects K present and target requires absence, reset authors exactly one `Delete(K,reason=reset)`. If absence is already selected, no redundant delete.

## Trace 37: bootstrap stale node with partial proof

Legacy K has inputs A/B, is stale, with only A->K validity. Canonical bootstrap writes partial basis `{A:A0,B:"unknown"}` and value-scoped stale marker. Replay reproduces partial proof without invented provenance.

## Trace 38: projection rebuild

Authoritative Journal is valid but derived graph bytes are damaged. Maintenance rebuilds projection without semantic event.

## Trace 39: synchronization normalization is real history

Receiver sees winning delete A from Y and authors dependent delete B; unseen concurrent A2 from Z arrives later. The B deletion remains real history. Different counterfactual schedules may author different normalization history while each fair execution converges.