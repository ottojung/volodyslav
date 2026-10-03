# Release safety

Release safety is the set of practices that make Volodyslav safe to install, upgrade, synchronize, migrate, and recover.

The central concern is not only whether the code builds or tests pass. A release can still be unsafe if it can corrupt durable state, lose data, make synchronization ambiguous, apply a migration incorrectly, publish a half-written database state, or make rollback difficult. Release safety exists to prevent these outcomes, detect them early, and preserve a path back to a known-good state.

## Failure modes

Volodyslav treats the following as release-safety concerns:

* data loss;
* database corruption;
* incorrect migrations;
* incompatible persisted formats;
* synchronization conflicts;
* partial writes becoming observable;
* generated state diverging from durable state;
* installation of code with known unresolved correctness blockers;
* loss of retained Journal history during recovery.

A release is safe only when these failure modes have been considered and the relevant safeguards are in place.

## Recovery is forward-only

Journal 3 makes the Journal the semantic authority for IncrementalGraph state, so recovery does not restore an older database over a newer one.

Replacing an existing local database with an older checkpoint, or rewinding its remote publication to an earlier state, can make already-published writer coordinates disappear and later be re-authored while an older copy may still re-enter supported history. Journal 3 therefore does not treat either operation as release recovery; see `$id-5083197642258146`.

Recovery from a bad release moves retained history forward:

* a corrected release uses ordinary supported operations;
* when a database-version transition is required, the corrected release adds a new canonical Journal-aware migration step;
* when version and schema remain compatible, `resetTo()` may re-establish a known-good source projection while retaining all history already observed by the receiver. That is semantic rebaselining, not database rollback.

Checkpoints remain useful. They support diagnosis and data inspection of a database directory, and `incremental-graph-journal-replay.md` derives current state from retained history. A checkpoint is not replacement authority for an existing Journal database, and it is not permission to rewind remote publication.

A failed release is corrected forward. It is not undone.

## Atomicity in the database

Volodyslav tries to avoid exposing half-applied durable state.

Many operations update several records that only make sense together. In the incremental graph, for example, values, freshness, validity sets, timestamps, and semantic-key-to-identifier mappings together describe one logical graph state. Publishing only some of those records can create a database that is syntactically readable but semantically inconsistent.

Release-safe persistence code should therefore preserve atomicity at the level of the logical operation, not merely at the level of an individual key-value write.

For incremental graph persistence, this means durable writes are committed before the corresponding volatile identifier lookup is published. The important invariant is that observable memory should not claim a persisted fact that the database does not yet contain.

For synchronization and migration, this means incoming or transformed state should be prepared in staging storage or an inactive replica. The active state should change only after the candidate state has been checked and written successfully.

## Versioned storage and explicit migrations

Volodyslav stores version metadata with database state. Code that opens a database can check whether the persisted format is the format it expects.

Format transitions should be explicit. A migration should be a deliberate operation with a known source format and target format. Silent best-effort repair is avoided when the system cannot prove what it is repairing.

When old snapshots require a special conversion path, that path should be owned by a specific migration or conversion script rather than hidden inside unrelated runtime code.

## Synchronization safety

Synchronization is release-sensitive because it combines state from multiple places.

Volodyslav synchronization should validate versions, validate identifier metadata, stage incoming state, merge graph records deliberately, rebuild derived indexes where appropriate, and only then publish the result.

Known synchronization cases that are not correctly handled must be treated as release blockers. For example, if two hosts can independently assign different storage identifiers to the same semantic node key and the current merge algorithm cannot repair that situation, that is not merely a TODO. It is a condition that must prevent installation until resolved.

Under Journal 3 the same condition has a second name: a writer fork. `incremental-graph-journal-errors.md` classifies it, and the journal sublevel's disjointness rules make an unarbitrated divergence a fork rather than a merge problem, because each writer's stream is contiguous and immutable. Startup takes the corresponding decision before any graph API exists: `journal_bootstrap_gate.js` resolves a canonical bootstrap for a supported pre-Journal replica, and `lifecycle.js` throws `UnresolvedCanonicalBootstrapError` rather than constructing a graph over an unresolved publication.

## Release-blocker markers

Some unsafe states are useful to keep in the repository temporarily while a larger change is being developed. For those cases, Volodyslav uses explicit release-blocker markers.

A release-blocker marker is a unique string placed next to a known unresolved release-safety issue:

```text
THIS-MARKER-BLOCKS-VOLODYSLAV-RELEASE-XXXXX
```

The `link-targeted` step in the install path scans tracked files for this marker.
If the marker is present, installation fails and reports the matching locations.
This covers `make install`, `scripts/install`, and any path that eventually links
installed files — the shared final step for all install entry points.

This is intentionally stronger than a comment. A comment informs a reader; a release-blocker marker changes program behavior. It turns a known unsafe repository state into an executable guardrail.

For non-release CI or installation tests, the blocker may be bypassed explicitly with an environment variable. The bypass is explicit because “running on CI” does not by itself mean “safe to ignore release blockers.”

## Build, test, and static checks

Builds, tests, linting, and type checking are part of release safety, but they are not the whole policy.

They help catch implementation errors before installation. They are especially important for persistence code, migration code, synchronization code, and filesystem rendering code, where small regressions can affect durable state.

However, passing tests does not automatically mean a release is safe. Known unresolved correctness issues still require release blockers, and durable-state changes still require migration planning and a forward-recovery plan.

## Policy

A change that affects durable state, synchronization, migration, installation, or generated graph state should answer these questions:

1. What persisted state can this change read or write?
2. Can a failure leave active state partially updated?
3. If the release is bad, what is the forward-recovery path?
4. Does the stored format have version metadata?
5. Are migrations explicit?
6. Is incoming synchronized state staged before publication?
7. Are metadata invariants validated?
8. Are known unresolved correctness issues marked as release blockers?
9. Can installation accidentally proceed while a blocker remains?

Release safety is not one mechanism. It is the combination of forward recovery, explicit formats, atomic database publication, staging, validation, tests, and install-time guards.
