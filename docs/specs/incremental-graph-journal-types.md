# IncrementalGraph journal types

## Logical replicated journal

The journal is notification and history infrastructure. It is not authoritative
graph state: current values, materialization, freshness, timestamps, and
validity come from the IncrementalGraph.

### Supported-state boundary

The [journal entry-point scope](../incremental-graph-journal.md#implementationrollout-scope)
is normative here. A supported state means one produced by lifecycle
transitions of an implementation satisfying these specifications, not every
database produced by every historical Volodyslav implementation. Pre-journal
implementation states are outside this journal-state universe until a rollout
establishes the journal-enabled representation; that rollout is a deployment
compatibility concern, not a journal transition.

This specification inherits the definition of supported and corrupted or
unsupported database state from
[`database-lifecycle.md`](database-lifecycle.md#11-corruption-model). Journal
correctness, synchronization, compaction, convergence, freshness, provenance,
and cursor-coverage guarantees range only over states produced by supported
Volodyslav lifecycle transitions and deliveries or unions that can arise
between those states. An arbitrary mathematical set of structurally
constructible `JournalEntry` values is not necessarily a supported journal
history.

A state requiring violation of an authoring, lifecycle, locking, clock,
immutability, or causal-context invariant is corrupted or unsupported in the
lifecycle specification's sense. Unless explicitly specified otherwise, the
protocol promises neither detection, rejection, recovery, convergence, nor
preservation of forensic evidence for such a state. Implementations MAY retain
cheap defensive rejection checks, but semantic correctness does not depend on
their completeness and compaction need not preserve evidence solely for future
corruption diagnosis.

```text
JournalEntry =
    AddJournalEntry
  | DeleteJournalEntry
  | EditJournalEntry
  | InvalidateJournalEntry
  | ValidateJournalEntry

JournalEntryBase = {
    author: DatabaseFingerprint
    sequence: uint64
    key: NodeKey
    time: UnixTimestamp
}

AddJournalEntry = JournalEntryBase & { action: "add" }
DeleteJournalEntry = JournalEntryBase & { action: "delete" }

GenerationScopedJournalEntryBase = JournalEntryBase & {
    generation: JournalEntryId
}

EditJournalEntry = GenerationScopedJournalEntryBase & { action: "edit" }
InvalidateJournalEntry =
    GenerationScopedJournalEntryBase & { action: "invalidate" }
ValidateJournalEntry =
    GenerationScopedJournalEntryBase & {
        action: "validate"
        clearsInvalidates: InvalidationContext
    }

InvalidationContext = Map<DatabaseFingerprint, JournalEntryId>

JournalEntryId(E) = (E.sequence, E.author)
```

Entry IDs are ordered lexicographically, sequence first and author second.
`JournalEntry.time` is always the real wall-clock time at which that journal
event occurred. For add/edit, that occurrence is the semantic value creation or
modification, and the entry time equals
`toUnixTimestamp(timestamps[key].modifiedAt)`. Delete, invalidate, and validate
use their actual event occurrence instant without changing graph `modifiedAt`.

`DatabaseFingerprint` is the existing IncrementalGraph database allocation
fingerprint specified by
[`incremental-graph-fingerprint.md`](incremental-graph-fingerprint.md) and
stored at `rendered/r/global/fingerprint`. Each host H owns one
`DatabaseFingerprint(H)`. A locally authored entry uses that local database
fingerprint as `author`, independently of the affected node's identifier.
Every `NodeIdentifier` allocated by H embeds `DatabaseFingerprint(H)`, but a
receiver may store identifiers allocated by remote hosts after synchronization.
Consequently, an arbitrary stored `NodeIdentifier` need not embed the
receiver's fingerprint, and its suffix MUST NOT determine the author of a
locally authored entry.

`UnixTimestamp` has a signed 64-bit persistent representation counting
milliseconds since `1970-01-01T00:00:00Z`. A valid `UnixTimestamp` is only a
value in that representation for which the project's `DateTime` abstraction can
represent the exact instant and round-trip the exact integer millisecond. Its
equality is integer equality and its order is signed integer order. It is
timezone-free, canonical, fixed-width, and has millisecond precision. Journal
wall-clock identity and ordering use that precision; distinct events represented
in one millisecond may have equal timestamps and are disambiguated by
`(sequence, author)`.

The graph and application timestamp type remains nominal `DateTime`. The
normative exact conversions are:

```text
toUnixTimestamp(dt: DateTime): UnixTimestamp = dt.toMillis()
fromUnixTimestamp(t: UnixTimestamp): DateTime = DateTime for instant t in UTC
toUnixTimestamp(fromUnixTimestamp(t)) == t
```

`toUnixTimestamp` accepts only a `DateTime` whose `toMillis()` is an integer in
the signed 64-bit range and is exactly representable by `DateTime`.
`fromUnixTimestamp` is total only over valid `UnixTimestamp` values, not over
all raw signed 64-bit integers. The graph's supported timestamp precision is
milliseconds. UTC is the canonical construction zone for
`fromUnixTimestamp`. Journal comparisons operate only on the resulting signed
integers.

A persisted raw signed 64-bit value outside this valid domain is malformed
journal state and load validation MUST reject it immediately. It MUST NOT be
clamped, rounded, approximated, normalized, or retained until a later API
conversion fails. Supported authoring obtains event time from the supported
`DateTime`/clock API and passes through `toUnixTimestamp`, so it cannot author an
invalid value. Import preserves the already-valid immutable timestamp of a
supported remote entry.

There is no separate journal membership domain. Supported host creation
allocates one globally unique durable `DatabaseFingerprint`; restoration may resume
it only from that host's current synchronized state. Reset, migration, and
copying never transfer ownership. Supported authoring makes every author a
well-formed supported `DatabaseFingerprint` and gives one immutable content to each
`JournalEntryId`. Implementations MAY check these facts defensively when the
relevant evidence is available. Duplicate ownership or rollback under the same
author is corrupted or unsupported under the lifecycle definition; complete
historical detection after compaction is not promised.

The journal has no fixed closed writer-membership domain. A supported new host
may introduce a new durable `DatabaseFingerprint`, so storage is not bounded
independently of the number of durable authors represented in retained history.

Entries are immutable. A remotely learned entry is imported byte-for-byte with
the same author and sequence. Learning an entry never re-authors it.

The union makes generation membership structural rather than optional.
`generation` is the exact `JournalEntryId` of the same-key `AddJournalEntry`
which established the materialization incarnation being edited, invalidated, or
validated. `AddJournalEntry` and `DeleteJournalEntry` have no `generation`
field; each of the other three variants requires it. This reference is journal
history only and is never stored on a graph materialization.

For example, if `G1=(10,A)` is an add for K, every edit, invalidate, and validate
for that incarnation contains `generation=(10,A)`, while a delete for K has no
generation field. After a delete and later add `G2=(50,B)`, subsequent scoped
events for the new incarnation contain `generation=(50,B)`. Events scoped to G1
are inapplicable to G2.

`clearsInvalidates` is immutable causal evidence, not a Lamport threshold. Each mapping `A -> I` MUST resolve to a real invalidate authored by A for the validation's exact key and generation. It contains at most one reference per author: the greatest same-author invalidate in the exact transaction-visible frontier at ordinary graph revalidation or authoritative existing-live stale→fresh reset. Retained state must satisfy these structural reference preconditions in order to be interpreted. The named invalidate must also have `I.sequence < V.sequence`; observed entries raise the validating author allocator before V is allocated. Normal synchronization and migration do not author validate.

Supported authoring additionally guarantees, for validations V1 and V2 by the
same author, key, and generation:

```text
V1.sequence < V2.sequence
    =>
V1.clearsInvalidates <=componentwise V2.clearsInvalidates
```

A correct durable author never forgets an invalidation already observed. V2
may add or advance coordinates but cannot forget or move one backward. This is
a supported-authoring and reachable-state invariant; it justifies later
same-author validation dominance during compaction. It is not an obligation for
compacted state to retain discarded validations so that every remote point in
an arbitrarily fabricated past remains diagnosable.

For example, this history for one author B, key K, and generation G is outside
the supported model:

```text
V10 clears X:I5
V15 clears X:I4
V20 clears X:I6
```

The `I5 -> I4` transition regresses B's causal knowledge and cannot be authored
through the supported protocol. Compaction therefore need not retain V10 merely
so a later-delivered corrupted V15 can be diagnosed. A defensive validator MAY
reject this history when the conflicting evidence is available; complete
historical detection after compaction is not promised.

Action variant and authorship context are orthogonal. Ordinary mutation,
migration, synchronization-authored destruction, and controlled reset all use
these same variants without an origin discriminator. In particular,
synchronization may author `DeleteJournalEntry` or an
`InvalidateJournalEntry` carrying its required generation; normal synchronization
never authors add, edit, or validate. Reset uses these variants with its narrow
changed-value fresh-generation rule.

Journal validation rejects an entry with action edit, invalidate, or validate
unless its generation resolves to a valid same-key add in the merge input.
Compaction retains an add-reference witness for every retained generation-scoped
notification. It may discard additional value/freshness authority for a losing
generation only after proving that the generation can never again become the
winning presence generation, as specified by the compaction rules.

## Closed action classifier

```text
add        iff absent -> materialized
edit       iff materialized -> materialized and ComputedValue changes
delete     iff materialized -> absent
invalidate iff up-to-date -> potentially-outdated
validate   iff potentially-outdated -> up-to-date
```

The public classifier remains transition-based. Independently, no operation may
make a materialized cache require genuine later revalidation without causally
representing that obligation in its generation's invalidation frontier. Explicit
invalidation, synchronization or migration stale→stale hardening, and equivalent
lifecycle paths therefore author an internal generation-scoped invalidate when
they remove/reassert absence of sufficient incoming proofs; its all-actions query
projection may be a permitted false positive. Settled hard-invalidated state
already represented by an outstanding barrier is merely carried. There is no generic `change`. Identifier, timestamp, validity-only, dependency,
or representation changes are not edits. `Unchanged` emits no edit. Value and
freshness transitions may emit two entries when both classifiers apply.

This classifier governs ordinary graph mutation, synchronization, and migration.
Controlled reset has one narrow presence-authority rule: unequal present values
receive a fresh add generation above all receiver history observed by reset.
Equal values remain silent, new materializations emit add, and removed
materializations emit delete. Reset uses no reset-specific record type.

## Host-local journal clock

Each writable host owns one persistent `localJournalClock: uint64`, protected
by a dedicated allocator mutex. It is a journal-only Lamport-style clock, not a
graph clock and not a per-node counter.

1. Sequences are never reused, including after an aborted reservation.
2. Importing or observing entries raises the allocator watermark to at least
   their maximum sequence.
3. Allocation increments the watermark and uses the result.
4. Consequently, if `E2` is authored after observing `E1`, then
   `E2.sequence > E1.sequence`.
5. Concurrent authors may use the same sequence; author breaks the tie.
6. Overflow is fatal and wrapping is forbidden.

## Durable logical and notification journals

Logical history and notification occurrences are distinct persistent structures:

```text
logicalJournal.entries: Map<JournalEntryId, JournalEntry>
notificationJournal.records: Map<JournalIndex, JournalRecord>
localJournalClock: uint64
localJournalRecordClock: uint64
journalRecordHighWatermark: Baseline | JournalIndex
cursorCoverageFrontier:
    Map<DatabaseFingerprint, Baseline | JournalIndex>
localCursorTokenSigningKey: Ed25519PrivateKey
cursorTokenVerificationKeys:
    Map<DatabaseFingerprint, Ed25519PublicKey>
```

`JournalEntry.sequence`, allocated from `localJournalClock`, is the replicated
logical event coordinate and forms `JournalEntryId` with `author`. Notification
ordering uses a separate coordinate:

```text
JournalIndex = (appendSequence: uint64, appender: DatabaseFingerprint)
JournalRecord = {
    index: JournalIndex,
    key: NodeKey,
    nodeName: NodeName,
    bindings: BindingEnvironment,
    time: UnixTimestamp
}
```

Indexes compare lexicographically by append sequence and then appender. They are
globally comparable, immutable, and replicated. `appender` is the durable
fingerprint of the appending host. The append sequence is never
`JournalEntry.sequence`: the allocators and all conflict semantics are
independent. Notification replay cannot affect logical identity, presence,
`ValueRevision`, conflict resolution, or validation causality.

`JournalRecord` is immutable, self-contained conservative notification evidence,
not graph authority. It carries the complete semantic address needed to apply a
`NodeFilter` and construct public results after graph and logical evidence have
been deleted. `key` MUST equal the implementation's identity-preserving
`NodeKey(nodeName,bindings)` result; storage-load and merge validation reject a
mismatch. This does not require `NodeKey` itself to be reversible. The record
carries no action and need not reference retained logical evidence. Its `time` is
witness time, not append time. Every query projects it to add, edit, delete,
invalidate, and validate. A logical entry E is
notified with `(E.key,E.nodeName,E.bindings,E.time)`. A conservative reappend uses the post-operation
`notificationWitness(K).time`; reset may instead copy the greatest merged same-key record's `(key,nodeName,bindings,time)` where no final logical witness is retained.

Each writable host durably owns `localJournalRecordClock`. Sequences are never
reused; gaps are harmless; overflow is fatal. Before appending after remote
observation, the allocator is raised above every observed append sequence and
the new index is `(incrementedClock,localFingerprint)`. Every local append is
strictly greater than the current high-watermark. Concurrent equal numeric
sequences are ordered by appender. One mutex may protect both allocators, but
their stored values and meanings remain separate.

`journalRecordHighWatermark` is the greatest index ever incorporated. It never
decreases, is at least every surviving record, survives compaction, restart,
migration, restoration and synchronization, and may name a deleted record. It
cannot be reconstructed from survivors. The coverage frontier is monotone and:

```text
cursorCoverageFrontier[localFingerprint] == journalRecordHighWatermark
```

after every commit. Coordinate `frontier[H]=W` proves this receiver can interpret
tokens issued by H at a high-watermark no greater than W. Notification records
and coverage frontiers replicate; the matching issuer verification-key mapping
travels with every represented frontier lineage. A fingerprint associated with
two different verification keys is corrupted/unsupported state. The local 32-byte Ed25519 private key and matching 32-byte public key are durable across restart and migration. Private keys never replicate; only public verification keys do. Logical equality ignores notification multiplicity and token-key
metadata.

At every supported commit: every logical ID and notification index names one
immutable content; appenders are valid durable fingerprints and never reuse a
sequence; both watermark and frontier are monotone; the local record clock
dominates every observed sequence required before its next append; each local
notification-relevant transition has a same-key record after the old
high-watermark; newly adopted cursor lineage and its authenticated verification key are covered before its frontier
advances; notification compaction retains each represented key's greatest
record; gaps are valid; logical semantics ignore notification order and
multiplicity; and cursor queries do not mutate state. Violations are
corrupted/unsupported state.

## Persisted graph boundary

Materializations remain exactly the graph concepts `values`, `freshness`, real
wall-clock `timestamps { createdAt, modifiedAt }`, identifier lookup,
`NodeIdentifier`, and `valid`. They contain no journal entry ID, virtual time,
revision stamp, support vector, epoch, vector clock, or synchronization field.
Synchronization never advances `modifiedAt` merely because bytes were copied.

For storage analysis:

```text
n = number of current or historic semantic node keys represented by either the
    compacted logical journal or compacted notification journal
r = number of durable fingerprints represented by compacted logical entries,
    retained causal-context references, cursorCoverageFrontier, or the
    cursor-token verification-key registry
a = 5 journal actions, a fixed constant
C = maximum serialized size of one ConstValue, a fixed system constant
K = maximum serialized size of one NodeKey, a fixed system constant
d = maximum number of distinct direct semantic inputs of any node, a fixed
    system constant
```

These are storage-model assumptions, not consequences of the semantic types.
`SimpleValue` and its `ConstValue` subtype permit recursively structured values
and do not intrinsically bound string, array, record, nesting, or serialized
size, so its definition does not establish C. The `NodeKey` format is
implementation-defined and its identity-preservation contract does not bound
encoding overhead, so that contract does not establish K. Bounded C, fixed
finite schema arity, and an intended bounded-overhead key encoding are
compatible with bounded K, but K remains a separate explicit premise. The same fixed finite schema bounds `NodeName` size and binding count; fixed C then bounds the complete `(nodeName,bindings)` address stored redundantly in each notification record. Every
compliant `DatabaseFingerprint` is exactly 16 lowercase ASCII letters, so its
serialized payload is normatively bounded rather than assumed. Graph
finiteness does not establish d because in-degree could grow with n. A fixed
finite schema with finitely many direct input positions per node definition is
compatible with bounded d, but d also remains an explicit premise. C, K, and d
are all assumed bounded independently of n and r; no runtime limit is implied.

The normative guarantee remains `size(compact(J)) = O(nr²)`, asymptotically in
n and r. Journal entries contain `NodeKey` values, `DatabaseFingerprint`
authors, and causal metadata, so this
journal-only bound assumes fixed K. Hidden constants may also depend on the
fixed number of action classes and fixed-width `UnixTimestamp`, sequence, and
notification-index scalar coordinates. `DatabaseFingerprint` payloads are bounded by
their normative 16-character ASCII representation.
A `JournalEntryId` is bounded because it combines a fixed-width sequence with a
normatively bounded `DatabaseFingerprint`; it is not a separate premise.
Constant action coordinates use `O(r)`
entries per key; at most `O(r)` retained validations each carry an `O(r)`
context, including exact causal references. Other journal witnesses are no
larger. The separate compact notification and coverage metadata add only `O(n+r)` and do not alter the result. The theorem does not
claim independence from arbitrarily growing key encodings.

The broader persisted IncrementalGraph state may also store dependency,
validity, and per-input information whose per-node width is bounded under fixed
d. That graph state is not part of `J`, so d is not needed to count
`compact(J)`. No total byte bound for all persisted graph state is asserted
here; such a bound would also have to account for `ComputedValue` payload size.

This applies exclusively to fully canonical compacted state. Ordinary mutations may append immutable entries and skip compaction arbitrarily long, so no operation-count-independent bound is promised for an uncompacted physical journal.
