# IncrementalGraph journal emission

## Atomic local classification

A successful normal graph transaction compares its committed before and after
states and applies the closed classifier in the journal types specification.
Intermediate states do not emit. The graph mutation and every locally authored
entry commit atomically; a reachable committed snapshot never contains one
without the other.

Before authoring, reserve one sequence per entry from the dedicated host-local
journal-clock allocator. The allocator first observes the maximum sequence in
the transaction's installed journal, then increments. Multiple entries receive
distinct increasing sequences. Aborted reservations may leave gaps but are
never reused; overflow is fatal.

For `add` and `edit`, `JournalEntry.time` MUST equal the resulting graph
materialization's exact `timestamps[key].modifiedAt`. The mutation obtains that
timestamp once and uses the same value for both records; two independent
`now()` reads are forbidden. For delete, invalidate, and validate, `time` is the
actual transition time.

Before changing an already-materialized value, invalidating, or revalidating,
derive the materialization's exact establishing add ID G from the
pre-transaction graph/journal snapshot. An emitted edit, invalidate, or validate
MUST carry `generation=G`. If G cannot be resolved, the transaction is an
invariant violation and cannot commit. A newly materialized value emits add,
which itself establishes G and carries no generation. Delete also carries no
generation. `Unchanged` still emits no edit.

| Before | After | Entries |
|---|---|---|
| absent | materialized | `add` |
| value A | unequal value B | `edit` |
| value A | `Unchanged` value A | none |
| materialized | absent | `delete` |
| fresh | stale | `invalidate` |
| stale | fresh | `validate` |

Identifier-only, timestamp-only, and validity-edge-only changes emit nothing.

## Synchronization emission

Synchronization invokes no computor and therefore cannot invent a semantic
`ComputedValue`. Copying or selecting an existing value imports its originating
`add`/`edit` history unchanged and MUST NOT author an `add` or `edit`. An unknown
import receives a receiver-local index on its single stored entry.

Synchronization can derive genuinely new conservative facts:

* deleting incompatible caches or a joined generation for which no valid source
  carries usable bytes; and
* invalidating a cache whose freshness proof cannot safely survive.

For a newly caused transition it authors `delete` or `invalidate`. Each such
sequence is greater than every entry observed by that synchronization operation,
and the graph transition, joined journal, stored entry/index, and watermarks are
installed atomically. An already known covering destructive entry is propagated,
not re-authored. Synchronization never synthesizes `validate`; only normal graph
revalidation with coherent validity evidence may do that.

A synchronization-authored invalidate sets `generation` to the final joined add
generation whose selected materialization it demotes. It cannot be emitted when
final presence is absent or the add generation is unresolved.

Logical emission and receiver-local cursor indexing are one stored-journal
operation. Every newly authored entry receives a distinct increasing
`localIndex` above the pre-transaction `localJournalIndexWatermark`. Every newly
installed remote entry does likewise while retaining immutable logical contents.
Receiving an already-known entry alone does nothing.

For synchronization, compute the compacted logical result and all graph
transitions first. For each changed semantic key K, a newly installed/authored
entry for K supplies fresh cursor coverage; otherwise touch the greatest retained
`notificationWitness(K)` exactly once. This includes every structurally deleted
or transitively invalidated dependent whose graph state changed. The graph,
logical entries, local-index changes, and both allocator watermarks commit
atomically.

Ordinary mutations author exact classifier entries. Several entries for one key
receive distinct local indexes, and no touch is needed unless some real
transition lacks a freshly indexed entry. `Unchanged` remains silent.

A settled equivalent synchronization authors no entry, learns no entry, touches
nothing, changes no graph, and advances neither watermark.

## Reachability invariant

All correctness arguments range over snapshots reachable through atomic normal
mutations, migrations that preserve these invariants, and the synchronization
protocol. Arbitrary mismatched graph/journal pairs are corrupt inputs, not
ordinary conflicts.
