# IncrementalGraph Journal 3 Worked Traces

## Purpose

These traces are explanatory tests of the normative Journal 3 rules.

They do not replace the formal specifications. When a trace and a normative rule appear to disagree, the normative rule wins and the trace must be corrected.

For brevity, record version, exact HLC values, complete contexts, physical identifiers, and timestamps are omitted where they are not the point of the example. Sequence order shown within one writer is authoritative.

Assume structural dependency:

```text
A -> B -> C
```

unless a trace says otherwise.

Certificate bases are written explicitly as `{ input, value }` records. The basis is self-describing historical evidence; it is not interpreted by remembering an old positional schema order. Persisted basis entries are canonically ordered by semantic NodeKey.

## Trace 1: first materialization

Writer X pulls previously absent A and the computor returns payload `a1`.

History:

```text
X:1 Value(A, payload=a1)        # ValueId X:1
X:2 Validate(A, value=X:1, basis=[])
```

Projection:

```text
A = a1
A fresh
```

No separate "add" metadata is needed. Presence comes from the selected ValueEvent.

## Trace 2: changed recomputation propagates staleness

Before:

```text
A = X:1, fresh
B = X:3, fresh, basis [{ input:A, value:X:1 }]
C = X:5, fresh, basis [{ input:B, value:X:3 }]
```

A recomputes to `a2`.

One possible publication order:

```text
X:7 Value(A, payload=a2)                  # new ValueId X:7
X:8 Validate(A, value=X:7, basis=[])
X:9 Invalidate(B, value=X:3, propagated)
X:10 Invalidate(C, value=X:5, propagated)
```

Projection:

```text
A = X:7, fresh
B = X:3, stale
C = X:5, stale
```

B/C payloads are preserved as cached oldValue candidates. Their staleness is explicit replay history.

## Trace 3: explicit invalidate then Unchanged

Before:

```text
A = X:1, fresh
B = X:3, fresh, basis [{ input:A, value:X:1 }]
```

Explicitly invalidate A:

```text
X:7 Invalidate(A, scope=node, explicit)
X:8 Invalidate(B, scope=value(X:3), propagated)
```

Projection:

```text
A stale
B stale
```

Pull A. Its computor returns `Unchanged`:

```text
X:9 Validate(A, value=X:1, basis=[])
```

Now:

```text
A fresh
B still stale
```

The later A validation causally covers A's node invalidation, but it does not remove B's value-scoped propagated invalidation.

Only when B itself is pulled and cache-revalidates/recomputes can B become fresh:

```text
X:10 Validate(
    B,
    value=X:3,
    basis=[{ input:A, value:X:1 }]
)
```

Projection then has A/B fresh.

## Trace 4: concurrent values

Writer X and writer Y both start from a common value A0 and independently recompute A.

```text
X:20 Value(A, payload=x, modifiedAt=10:00)
Y:14 Value(A, payload=y, modifiedAt=10:01)
```

Neither event context contains the other.

They are concurrent. If their HLC physical components preserve these modifiedAt seeds, Y:14 wins because its authority time is later.

After synchronization every replica retaining both histories selects the same Y occurrence.

No payload comparison occurs.

## Trace 5: causality beats physical-time preference

Writer X authors:

```text
X:20 Value(A, payload=x, authority=(100,0))
```

Y observes X:20 while its wall clock/modifiedAt seed is only 90, then recomputes A.

Y must allocate authority after the observed high-water, e.g.:

```text
Y:14 Value(A, payload=y, authority=(100,1), context includes X:20)
```

Therefore:

```text
X:20 happenedBefore Y:14
X:20 < Y:14 by authority
```

even though Y's physical seed alone would have looked older.

## Trace 6: validation cannot reference a future value

Suppose retained union contains:

```text
X:5 Validate(
    B,
    value=X:3,
    basis=[{ input:A, value:Y:9 }]
)
Y:9 Value(A, ...)
```

but X:5's context does not observe Y through 9 and Y:9 is not a same-writer-earlier record.

This is malformed history.

The eventual presence of Y:9 in the union does not retroactively make X:5 valid evidence.

Synchronization/replay rejects the certificate rather than substituting some other ValueId or dropping only that basis entry.

## Trace 7: receiver-only dependent becomes persistently stale

Receiver X has:

```text
A = A1, fresh
B = B1, fresh, basis [{ input:A, value:A1 }]
```

A remote source contains a new selected A2 but never materialized B:

```text
Y:10 Value(A, payload=a2)
Y:11 Validate(A, value=Y:10, basis=[])
```

After raw history union:

```text
A selects Y:10
B still selects B1
B's old basis entry for A names A1 rather than current Y:10
```

Tentative replay makes B stale.

Because B was fresh before sync and keeps the same B1 ValueId, receiver X authors:

```text
X:n Invalidate(B, scope=value(B1), reason=sync)
```

Later A may itself be invalidated and revalidate unchanged as Y:10. B must remain stale until B is pulled. The sync invalidation guarantees that behavior.

## Trace 8: source deletes an input

Receiver has materialized:

```text
A -> B -> C
```

Remote history contains a DeleteEvent for A which wins current head selection.

Raw union would otherwise leave historical ValueEvents selected for B/C.

Journal 3 synchronization computes the structural removal closure and authors receiver events in dependency order:

```text
X:n   Delete(B, reason=sync)
X:n+1 Delete(C, reason=sync)
```

A's winning imported delete plus B/C's receiver-authored deletes make current materialization dependency-closed.

B/C's old payload events remain historical but cannot silently reappear later.

## Trace 9: initial/full sync is zero-frontier sync

Source frontier:

```text
X:100
Y:50
```

Empty receiver:

```text
X:0
Y:0
```

Transfer:

```text
X:1..100
Y:1..50
```

Later receiver frontier:

```text
X:97
Y:50
```

uses the same algorithm and transfers:

```text
X:98..100
```

Only the starting frontier differs.

## Trace 10: repeat synchronization

After the receiver has incorporated all source records and authored any required sync normalization, synchronize again against the unchanged source.

No writer suffix is missing.

`Pbefore` is already the normalized projection, so no fresh-to-stale transition or dependency-closure repair is newly caused.

Result:

```text
changed=false
no new semantic records
same graph projection
```

## Trace 11: exact same-writer prefix recovery

Local installation A retained through:

```text
A:1..100
```

A controlled source contains:

```text
A:1..120
```

and records 1..100 agree exactly.

Under exclusive maintenance, import:

```text
A:101..120
```

reconstruct writer-local head/watermark/high-water, then continue new local authoring at A:121 or later.

No reset or re-authoring is required.

If source A:87 differs from local A:87, recovery fails with a writer-fork/corruption error.

## Trace 12: multi-input competing certificates

Node K has current direct inputs:

```text
A, B
```

Current selected input values after union are:

```text
A2, B2
```

Current selected K value is K1.

History has two causally eligible certificates with the same explicit input-key set:

```text
C1 basis=[
  { input:A, value:A2 },
  { input:B, value:B1 }
]

C2 basis=[
  { input:A, value:A1 },
  { input:B, value:B2 }
]
```

Each matches one current input.

Neither certificate may be split/combined into fictitious evidence:

```text
[
  { input:A, value:A2 },
  { input:B, value:B2 }
]
```

Journal 3 chooses one complete certificate using the specified basis-match-count then authority tie-break. The resulting `valid` projection contains only the matching edge(s) represented by that one chosen certificate.

If later C3 appears with:

```text
basis=[
  { input:A, value:A2 },
  { input:B, value:B2 }
]
```

and is eligible, it has two matches and becomes the preferred certificate.

## Trace 13: historical certificate from an old schema

Suppose an old schema for K had direct inputs A/B, and retained history includes:

```text
C_old basis=[
  { input:A, value:A1 },
  { input:B, value:B1 }
]
```

A later migration changes K's current direct-input set to A/C and emits a new migration ValueId/certificate baseline.

`C_old` remains fully decodable historical evidence: it unambiguously says it validated against A and B.

But it is not eligible proof for the current A/C schema because its explicit basis input-key set does not equal the current direct-input set.

Journal 3 therefore does not need the historical schema's positional input ordering merely to understand the old record, and it does not accidentally reinterpret old B evidence as current C evidence.

## Trace 14: concurrent node invalidation and validation

K has value K1.

Writer X validates K1 while writer Y concurrently explicitly invalidates K:

```text
X:10 Validate(K, value=K1, ...)
Y:7  Invalidate(K, scope=node, explicit)
```

Neither is causally after the other.

Even if X:10 compares later by total authority, it does not cover Y:7.

K remains stale / its incoming proof is not accepted as fresh proof.

A later validation Z which observes Y:7 can cover it.

This is why certificate clearing uses causality, not last-writer-wins authority.

## Trace 15: value-scoped invalidation dies with old occurrence

K currently selects K1 and has:

```text
Invalidate(K, scope=value(K1), propagated)
```

so K1 is stale.

Later a new current K2 ValueEvent wins.

The old K1 invalidation remains historical, but it does not make K2 stale. K2's freshness follows certificates/invalidation applicable to K2.

## Trace 16: reset is a new baseline, not history deletion

Receiver has current A=X:20.

Source target projects A=Y:8.

Reset first observes/imports source history, then authors a new receiver baseline:

```text
X:30 Value(A, payload copied from Y:8, reason=reset)
X:31 Validate(A, value=X:30, basis=[])
```

X:20 and Y:8 remain in history.

X:30 is causally after all history reset observed, so it establishes the requested current reset target relative to that observed history.

An unseen concurrent event from writer Z can still affect later ordinary synchronization when it is finally learned.

## Trace 17: bootstrap stale node with partial proof

Legacy graph has K with two current inputs A/B:

```text
K stale
valid[A] contains K
valid[B] does not contain K
```

Bootstrap first creates ValueIds A0, B0, K0.

Then it records:

```text
Validate(
  K,
  value=K0,
  basis=[
    { input:A, value:A0 },
    { input:B, value:"unknown" }
  ],
  reason=bootstrap
)
Invalidate(K, scope=value(K0), reason=bootstrap)
```

Replay reconstructs:

```text
K stale
A -> K validity edge present
B -> K validity edge absent
```

without inventing an unknown historical B occurrence.

## Trace 18: migration records results, not old code

Journal-aware migration computes target graph with K payload `new`.

It authors a new migration ValueEvent carrying the actual target payload/timestamps plus a target validation baseline whose explicit basis input keys describe the target schema.

Years later replay uses those immutable records.

It does not load or execute the historical migration callback which once computed `new`.

## Trace 19: projection rebuild

Assume authoritative journal is valid but a derived `freshness` LevelDB record is damaged.

Maintenance discards/rebuilds the materialized graph from journal history.

After rebuild:

```text
materializedGraph == project(journal)
```

No journal event is authored merely because a derived cache was repaired.

If the journal itself contains a fork/impossible causal reference, rebuild fails instead of changing history to match the damaged graph.

## Trace 20: synchronization normalization is real history

Assume structural edge:

```text
A -> B
```

Receiver X currently has fresh A1/B1.

Source Y contains a higher-authority DeleteEvent for A but has never materialized B. Source Z contains an even higher-authority concurrent ValueEvent A2.

If X synchronizes Y first, the observed state genuinely has A absent while B1 is selected. X must preserve dependency closure and authors:

```text
X:n Delete(B, reason=sync)
```

That delete is a real committed semantic event.

Later X synchronizes Z. A2 may now become the selected A head, but the already-authored X:n deletion of B is not retracted merely because the previously unseen A2 changed the later projection.

In a counterfactual execution that incorporated Z before Y, A might never have become absent at a committed synchronization boundary, so X:n might never have been authored.

Journal 3 does **not** claim those two counterfactual executions have identical history/result. It claims that in either actual execution, every committed normalization event is immutable history and fair synchronization eventually disseminates it so all replicas in that execution converge.

This is not an acknowledgement artifact: the deletion records a state transition that really occurred under the receiver's then-observed supported history.
