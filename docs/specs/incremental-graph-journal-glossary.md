# Journal 3 Glossary

**Journal author / writer** — Durable `DatabaseFingerprint` identity which owns one append-only writer stream.

**Writer stream** — Immutable contiguous sequence `A:1..A:q` authored under one writer identity.

**Journal record ID** — Pair `(author, sequence)` uniquely naming one immutable persisted record.

**Semantic event** — Journal record which directly contributes graph semantic history: ValueEvent, DeleteEvent, ValidateEvent, or InvalidateEvent.

**Writer-state record** — Non-semantic local allocator-history record, currently carrying `lastNodeIndex`.

**ValueId** — JournalRecordId of one ValueEvent; identity of one exact semantic value occurrence.

**Journal frontier** — Per-writer highest retained sequence coordinate. Missing coordinate means zero.

**Causally closed journal** — Retained history containing every writer prefix claimed by every retained semantic event's context.

**Stable source snapshot** — Immutable synchronization/reset read view with one fixed causally closed frontier and exact record contents through it.

**Replay / projection** — Deterministic interpretation `project(J)` which derives the current IncrementalGraph state from authoritative retained history.

**Materialized graph / projection** — Existing IncrementalGraph sublevels (`values`, `freshness`, `valid`, timestamps, identifiers, etc.) maintained for efficient runtime use but carrying no semantic authority absent from the journal.

**AuthorityTime** — HLC-style timestamp used in the total semantic conflict-precedence order.

**happened-before** — Partial causal relation derived from writer-stream order and semantic event contexts.

**Head** — Greatest current ValueEvent/DeleteEvent for one NodeKey according to semantic authority order.

**Certificate / ValidateEvent** — Historical evidence that one exact ValueId was validated against a basis of direct input ValueIds.

**Validation basis** — Ordered entries corresponding to direct input edges; normally exact ValueIds, with controlled `"unknown"` only for bootstrap/reset/migration baselines reproducing missing legacy proof.

**Node-scoped invalidation** — Direct invalidation of a node's incoming proof, cleared only by a causally later covering validation.

**Value-scoped invalidation** — Persistent stale marker for one exact cached value occurrence; does not by itself remove incoming validity proof and stops applying when another ValueId becomes current.

**Normalization** — Receiver-authored semantic events required after history union to preserve IncrementalGraph dependency-closure and persistent-staleness semantics.

**Same-writer prefix recovery** — Safe import of an exact longer continuation of the local writer's own immutable stream, followed by reconstruction of local allocator state.

**Writer fork** — Conflicting canonical record meaning under the same `(author,sequence)` identity. Not a normal graph conflict.

**Reset baseline** — New receiver-authored causally later current-state baseline used to make the receiver projection match a chosen source target while retaining old history.

**Migration baseline** — New local replay-complete baseline recording a migration's settled target graph so future replay does not rerun historical migration code.

**Bootstrap** — Initial conversion of supported pre-Journal-3 graph state into equivalent replay-complete journal history.

**Checkpoint** — Optional derived replay accelerator for an exact frontier. Not semantic authority and not permission to destroy old records.
