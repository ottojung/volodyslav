# IncrementalGraph journal migration

Migration uses the one journal and atomic semantic classification. New absent NodeKey materialization allocates a fresh identifier and authors generation(add)+exactly one initial validate/soft/hard assertion. Present unequal value uses scoped edit, not a new generation. If its migrated target remains stale, migration MUST follow that edit with a new soft or hard invalidate matching the target, regardless of pre-edit barriers. Equal value creates no value event. Delete retires the identifier.

Validation uses legitimate local closed-prefix evidence in `clearsThrough`. Propagated stale with reusable proof is soft; unrepresented must-recompute is hard; existing uncovered hard authority is carried. Event times and lazy allocation follow the types specification. Migration validates canonical addresses, generation references, timestamp domains, causal vectors, and graph/proof consistency before atomic cutover.
