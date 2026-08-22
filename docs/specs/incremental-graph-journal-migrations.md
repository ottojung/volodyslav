# IncrementalGraph journal migration

Migration uses the one journal and atomic semantic classification. Migration
never directly replaces the semantic value of an already-materialized node;
the `MigrationStorage` API has no present-unequal transition. Its reachable
transitions and journal effects are:

| Previous | Target/decision | Journal effect |
|---|---|---|
| absent | present via `create` | generation (`add`) plus exactly one initial `validate`, soft `invalidate`, or hard `invalidate` |
| present | absent via `delete` | `delete` |
| present | same semantic value via `override` | no value event; representation-only rewrite |
| present | same value via `keep` | no value event |
| present | same cached value via explicit or proof-hardening `invalidate` | only the appropriate soft or hard `invalidate` |

`override()` requires `isEqual` semantic equality and is value-journal-silent.
`invalidate()` preserves the cached value; it changes only freshness and the
recomputation obligation and therefore never authors `add` or `edit`.

Every migration validation names the exact current value origin and carries
prior same-author/key/generation causal knowledge. Validation uses legitimate
local closed-prefix evidence in `clearsThrough`. Propagated stale with reusable
proof is soft; unrepresented must-recompute is hard; existing uncovered hard
authority is carried. Event times and lazy allocation follow the types
specification. Migration validates canonical addresses, generation references,
timestamp domains, causal vectors, and graph/proof consistency before atomic
cutover.
