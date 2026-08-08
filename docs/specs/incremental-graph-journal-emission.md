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
`add`/`edit` history unchanged and MUST NOT author an `add` or `edit`. A local
delivery record may notify clients that imported history was learned.

Synchronization can derive genuinely new conservative facts:

* deleting an incompatible or provenance-unresolvable cache; and
* invalidating a cache whose freshness proof cannot safely survive.

For a newly caused transition it authors `delete` or `invalidate`. Each such
sequence is greater than every entry observed by that synchronization operation,
and the graph transition, joined journal, entry, and local delivery record are
installed atomically. An already known covering destructive entry is propagated,
not re-authored. Synchronization never synthesizes `validate`; only normal graph
revalidation with coherent validity evidence may do that.

A synchronization-authored invalidate sets `generation` to the final joined add
generation whose selected materialization it demotes. It cannot be emitted when
final presence is absent or the add generation is unresolved.

Logical emission and receiver-local delivery are separate. Every observable
graph transition caused by synchronization allocates a fresh local delivery
position, even when its causal logical entry was learned earlier. For copied
presence/value/freshness, the delivery record references the already-existing
originating add/edit/validate entry through optional `causeId` while storing the
exact local transition key, action, and time itself; it does not create or alter
a logical entry. A newly derived delete or
invalidate delivery references the newly authored destructive entry. Graph and
delivery commit atomically, so advancing a cursor after learning history cannot
hide a later graph transition caused by that history.

## Reachability invariant

All correctness arguments range over snapshots reachable through atomic normal
mutations, migrations that preserve these invariants, and the synchronization
protocol. Arbitrary mismatched graph/journal pairs are corrupt inputs, not
ordinary conflicts.
