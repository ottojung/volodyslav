# IncrementalGraph journal emission

Generation creation and freshness assertion are orthogonal but atomic:

| semantic decision | generation publicAction | exactly one initial freshness entry |
|---|---|---|
| absent -> materialized | add | validate / soft invalidate / hard invalidate |
| present unequal-value replacement requiring new generation | edit | validate / soft invalidate / hard invalidate |
| equal-value internal authority fence | null | validate / soft invalidate / hard invalidate |

The generation entry allocates first; its scoped freshness entry allocates later. Initial validate means positively established fresh, not merely stale-to-fresh. Initial invalidate is a precise negative assertion. Ordinary same-generation unequal-value change uses scoped edit. Present-to-absent uses delete.

Ordinary pull first materialization emits generation(add)+validate because its computed result is fresh. `Unchanged`, representation/identifier changes, carrying imports, and enforcing imported hard barriers emit no value action. Later propagated stale with proofs emits soft invalidate; newly unrepresented must-recompute emits hard invalidate; re-establishing fresh emits validate with the complete observed all-mode frontier. Partial contexts never combine.

Every transaction validates the canonical semantic address and atomically commits graph, events, lazy-raised allocator, coverage, identifiers, and references.
