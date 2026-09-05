# IncrementalGraph journal migration

Migration uses the one journal and atomic semantic classification. Migration
may directly change the semantic value of an already-materialized node. Its reachable
transitions and journal effects are:

| Previous | Target/decision | Journal effect |
|---|---|---|
| absent | present via `create` | generation (`add`) plus exactly one initial `validate`, soft `invalidate`, or hard `invalidate` |
| present | absent via `delete` | `delete` |
| present | equivalent persistence representation via `override` | no journal event; the existing semantic occurrence and provenance survive |
| present | same value via `keep` | no value event |
| present | same cached value via explicit or proof-hardening `invalidate` | only the appropriate soft or hard `invalidate` |

`create(nodeKeyString, value, cacheState)` accepts the closed cache-state union
defined by the migration API: `{ state: "up-to-date" }`,
`{ state: "stale-soft", proof: { inputs } }`, or `{ state: "stale-hard" }`.
Up-to-date, stale-soft, and stale-hard create author the table's initial
`validate`, soft `invalidate`, and hard `invalidate`, respectively.

For stale-soft derived create, the semantic-key proof identity and finalization
contract is defined by [the `MigrationStorage` API](migration.md#migrationstorage-api).
Finalization installs the complete incoming validity proof only after that
contract succeeds. A proof input resolved through `keep`, `override`,
`invalidate`, or `create` is compared with the surviving materialization's
final cached value. Explicit invalidation removes that input's incoming proofs
but preserves its cached semantic value and outgoing proof to the created
dependent. Stale-hard create installs no incoming proof. A zero-input
stale create cannot satisfy the nonempty reusable-proof contract and must use
stale-hard. An invalid or incomplete cache-state/proof envelope throws
`InvalidMigrationDecisionError` before journal or graph mutation.

`override()` does not apply `isEqual` to verify, infer, or classify semantic
equivalence. The migration author supplies that assertion. Override rewrites the
cached representation while retaining the existing value origin, generation,
provenance, timestamps, causal context, reset correspondence, reset-anchor cuts,
coverage, counters, and iterator-visible history. It authors no journal action.
Its explicit target state rebuilds only the graph freshness and incoming proof
required by the target schema; still-structural outgoing proofs remain valid.
The representation, selected graph cache state, target validity relation, and
unchanged journal state are published in the same replica cutover.
`invalidate()` preserves the cached value; it changes only freshness and the
recomputation obligation and therefore never authors `add` or `edit`.

Every migration validation names the exact current value origin and carries
prior same-author/key/generation clearing evidence. Validation uses legitimate
closed-prefix evidence in `clearsThrough`. Propagated stale with reusable proof
is soft; unrepresented must-recompute is hard; existing uncovered hard authority
is carried. A migration-authored invalidate takes the next local sequence and
its `causalContext` covers supported source authority used by the decision.
Proof-loss hardening therefore causally follows the observed authority without
comparing foreign sequences. Migration preserves `resetAnchorCuts` exactly;
these summaries remain absorption metadata and do not enter causal context or
causal summary. Migration validates canonical addresses, generation references,
timestamp domains, causal contexts, reset-anchor cut summaries, and graph/proof
consistency before atomic graph/journal/resetAnchorCuts/coverage/counter/
causalSummary/fingerprint cutover. Journal records and proof edges contain
identifiers and semantic occurrence coordinates rather than cached values, so
override requires no representation-dependent journal rewrite. Exact
database-version compatibility ensures synchronization occurs only after both
replicas apply their deterministic representation migration.

## Iterator-state preservation

A migration that preserves durable writer fingerprints and immutable journal
coordinates preserves `JournalIterator` progress and issuance coverage exactly;
it neither rebases nor renumbers either vector. Compaction during migration has
the same rule. A migration that legitimately changes writer history or
coordinates MUST explicitly reject the affected durable iterator-state version
at restoration rather than silently reinterpret it. Newly created iterators
remain the before-all migration-independent starting point.
