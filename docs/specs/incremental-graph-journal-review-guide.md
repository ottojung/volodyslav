# Journal 3 Review Guide

When reviewing Journal 3 implementation/spec changes, check the following questions in order.

## Is the fact authoritative or derived?

If authoritative, it must be represented by immutable journal history.

If derived, it must be reconstructible from journal history plus current compatible schema/version interpretation.

Do not accidentally make a new index/cache/sublevel into a second source of semantic truth.

## Does replay need anything not recorded?

For every transition ask:

```text
If values/freshness/valid/timestamps/identifier maps vanished,
can retained journal history reconstruct the result without running old code?
```

If not, the event model is incomplete.

## Is a foreign fact copied or re-authored?

Foreign immutable records stay under their original writer/ID.

Only genuinely new receiver semantic transitions (for example sync normalization) receive receiver-authored IDs.

## Does every ValueId reference prove observation?

ValidateEvent target/basis and value-scoped invalidation references must point to causally prior ValueEvents.

Eventual coexistence in one merged journal is not enough.

## Is conflict resolution causal where it needs to be?

Value/delete head precedence uses total authority.

Clearing node invalidation uses happened-before, not merely later total authority.

Do not replace causal-proof semantics with blanket last-writer-wins.

## Does a stale transition persist correctly?

Existing flag-based semantics require propagated fresh->stale state to survive until the affected node itself revalidates/recomputes.

Receiver-only dependents learned through sync are the canonical edge case.

## Is dependency closure explicit?

A removed input may require actual DeleteEvents over selected dependent caches.

Do not merely omit a selected ValueEvent from projection and allow the cached occurrence to resurrect automatically later.

## Could the local writer stream fork or gain holes?

Final IDs are allocated only in serialized publication finalization.

Exact longer same-writer prefix may be recovered; conflicting overlap must fail.

## Does an optimization preserve the reference model?

Indexes/checkpoints/incremental folding are acceptable only if differential behavior equals the declarative replay spec.

## Is transport creeping into semantics?

Git hashes, SQL row IDs, remote request boundaries, Supabase identifiers, etc. are not event identity/authority.

The journal should still make sense if transported by a different mechanism.

## Is historical format evolution safe?

Immutable retained records need explicit version decoding. New software cannot assume old records silently changed format.

## Does the change preserve repeat-operation fixed points?

Unchanged-source synchronization should not append more semantic history on every retry.

Already-satisfied reset may no-op.

Rebuild of valid derived state should not write semantic events.

## Can the user understand operation behavior?

Public graph operations should remain ordinary `pull`/`invalidate`/inspection semantics.

Administrative sync/reset/migration should clearly state:

- whether computors run;
- what can change;
- whether operation is atomic;
- what partial success means;
- what failures mean.
