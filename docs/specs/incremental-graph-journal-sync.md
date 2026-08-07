# Notification-clock synchronization

## Domain validation and synchronization boundary

Only `NotificationClock` is replicated journal state. `DeliveryByIndex`,
`DeliveryHead`, `lastLocalJournalIndex`, and physical gaps are host-local cursor
materialization and never participate in journal synchronization.

Before joining, validate both complete inputs and require:

```text
local.JournalDomain == remote.JournalDomain

domain.writerOrigins[local.localWriterId]
    == local.localJournalOrigin

domain.writerOrigins[remote.localWriterId]
    == remote.localJournalOrigin

local.localWriterId != remote.localWriterId
local.localJournalOrigin != remote.localJournalOrigin
```

Mapping equality is exact. Each staged peer declares its stable writer ID and
assigned origin. Reject either clock if any coordinate uses an origin outside
`set(domain.writerOrigins.values())`. Domain mismatch, unknown origin, malformed
component, ownership mismatch, and equal-sequence/time conflict reject
synchronization atomically and symmetrically before either result is installed.
Remote data never adds a writer or origin. Dynamic membership requires a
separately specified journal-domain migration.

Distinct independently writable peers must have distinct mapped writers and
origins. Claims are checked against the immutable mapping, not merely against
previously encountered peers.

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

Ordinary local emission, including synchronization-created emission, may occur
before or after a join. Emission changes an operand by advancing its assigned
origin; it does not change the commutative, associative, or idempotent laws of
`joinClock` itself.

Normatively, the laws apply only to `NotificationClock`:

```text
joinClock(A, B) = joinClock(B, A)
joinClock(joinClock(A, B), C) = joinClock(A, joinClock(B, C))
joinClock(A, A) = A
```

`mergeNotificationClocks(A,B) = joinClock(A,B)` is the binary journal merge
operator for already-emitted replicated states. The three laws above belong to
that operator alone.

```text
mergeNotificationClocks(A, B) = mergeNotificationClocks(B, A)

mergeNotificationClocks(mergeNotificationClocks(A, B), C)
    = mergeNotificationClocks(A, mergeNotificationClocks(B, C))

mergeNotificationClocks(A, A) = A
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
  some O has joinedClock[K][O][A].sequence
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

### Writer-ownership rejection across three hosts

```text
domain:
    WA -> OA
    WB -> OB
    WC -> OC

A declares: writer WA, origin OA
B declares: writer WB, origin OA
```

C rejects B because `domain.writerOrigins[WB] = OB` but
`B.localJournalOrigin = OA`. This works even when C synchronized with A and B
at different times: ownership is verified from the immutable domain.

### Supported fresh-host trace

```text
domain:
    WA -> OA
    WB -> OB

A is an existing host:
    allocation fingerprint FA
    localWriterId WA
    origin OA

B is created through the supported fresh-host lifecycle:
    allocation fingerprint FB
    localWriterId WB
    origin OB

require:
    FA != FB
    WA != WB
    OA != OB

B synchronizes with A:
    B keeps FB, WB, and OB
    B joins A's NotificationClock components
    B never advances OA
```

Normal synchronization validates a staged peer's mapped writer/origin claim and
also its recognized host branch identity supplied by the synchronization
lifecycle. These are correctness checks under the non-adversarial model, not
cryptographic or Byzantine authentication.

Raw cross-host copying of a live database is unsupported. A copied
`localWriterId`/`localJournalOrigin` pair is not proof of writer ownership, and
the journal mapping cannot authenticate the physical installation that holds
copied files.
