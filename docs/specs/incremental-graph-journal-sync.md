# Notification-clock synchronization

## Domain validation and synchronization boundary

Only `NotificationClock` is replicated journal state. `DeliveryByIndex`,
`DeliveryHead`, `lastLocalJournalIndex`, and physical gaps are host-local cursor
materialization and never participate in journal synchronization.

Before joining, validate both complete inputs and require:

```text
local.domainId == remote.domainId
local.allowedOrigins == remote.allowedOrigins
```

Set equality is exact. Reject either clock if any component names an origin
outside `allowedOrigins`. Domain mismatch, unknown origin, malformed component,
and equal-sequence/time conflict reject synchronization atomically and
symmetrically before either result is installed. Remote data never silently
adds an origin. Dynamic membership requires a separately specified
journal-domain migration.

Distinct independently writable peers must have distinct assigned local
origins. As a mandatory negative protocol test, two writable hosts configured
with the same local origin are rejected before either may synchronize as a
valid peer; neither destination is installed.

## Coordinate join

Missing coordinates have sequence zero. For each `(key, origin, action)`:

```text
joinComponent(a,b):
    if a.sequence > b.sequence: return a
    if b.sequence > a.sequence: return b
    require a.time == b.time
    return a

joinClock(A,B)[key][origin][action] =
    joinComponent(A[key][origin][action], B[key][origin][action])
```

Equal sequences with unequal times are corrupt or malformed input. Validation
rejects the entire input symmetrically and atomically before destination state
is installed.

## Algebraic proof

For valid components, sequence comparison chooses their maximum. Equal sequence
components are identical because validity requires equal times.

- **Commutativity:** `max(x,y) = max(y,x)`; either argument order selects the
  unique component at that maximum sequence. Therefore `joinClock(A,B) =
  joinClock(B,A)`.
- **Associativity:** both parenthesizations select the unique component whose
  sequence is `max(x,y,z)`. Therefore `joinClock(joinClock(A,B),C) =
  joinClock(A,joinClock(B,C))`.
- **Idempotence:** the maximum of a sequence with itself is itself, and times
  agree, so `joinClock(A,A) = A`.

A clock is a finite product over key/origin/action coordinates of max-counter
semilattices. Finite products preserve these three laws.

Normatively, the laws apply only to `NotificationClock`:

```text
joinClock(A, B) = joinClock(B, A)
joinClock(joinClock(A, B), C) = joinClock(A, joinClock(B, C))
joinClock(A, A) = A
```

Different hosts or synchronization schedules need not produce identical
physical delivery indices or watermarks. Local delivery state instead
guarantees no false negatives, same-process cursor continuity, one retained
record per key/action, and O(n) live records. Local delivery indices are cursor
infrastructure and are not part of the algebraic merge result.

## Independent coordinates

Actions cannot share one latest-action scalar. If a host emits `edit` and
`invalidate`, or adds then deletes before synchronization, every respective
counter advances and none overwrites another. Final graph equality does not
remove possible-change coverage.

Origins also cannot share an LWW scalar. If origin A has `edit[K] = 7` and B has
`edit[K] = 3`, the joined clock retains both. A receiver that had only A later
detects B. This is required for concurrent edits.

## Advanced-action detection

```text
RemoteAdvancedActions = {
  (K,A) |
  some O has finalClock[K][O][A].sequence
             > localClock[K][O][A].sequence
}
```

Only one destination delivery record is required per resulting `(K,A)`, even if
several origins advanced. Choose time deterministically from the advanced
component greatest under `(sequence, JournalOriginId)` and copy its time.

### Synchronization traces

- Concurrent origins edit K: both origin coordinates survive; a receiver detects
  advancement and emits one local `edit` delivery.
- Remote absent→present→absent: `add` and `delete` coordinates advance, so both
  are delivered although the receiver's final graph remains absent.
- Remote fresh→stale→fresh: `invalidate` and `validate` both advance and deliver.
- Remote A→B→A: `edit` advances twice; a receiver behind that coordinate reports
  `edit` although final values match.
- Repeated edit sequence 7→8→9: a receiver at 7 detects 9; intermediate edits
  collapse without losing possible-change coverage.

The clock join does not synchronize graph state and is never an input to graph
conflict resolution.

### Mandatory host-fork trace

```text
A:
    local origin OA
    edit[K][OA] = 5

copy A's storage to new writable host B

before B may mutate:
    B.local origin = OB
    OA != OB

B edits K:
    edit[K][OB] = 1

join retains:
    edit[K][OA] = 5
    edit[K][OB] = 1
```

B retains OA's copied component but never advances it. Copying storage does not
make B the OA writer. OB must be distinct, already allowed by the fixed domain,
and assigned before B's first authoritative graph mutation.
