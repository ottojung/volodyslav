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
* inability to roll back after a bad deployment.

A release is safe only when these failure modes have been considered and the relevant safeguards are in place.

## Durable checkpoints and rollback

The most important mitigation is that Volodyslav keeps checkpoints of its most important database state.

This means the system is not relying only on “the current database directory is valid.” Important persisted state is checkpointed over time, so a bad change does not have to be final. If an upgrade, migration, synchronization, or computation produces a bad result, rollback remains possible.

This changes the release model: the system is allowed to evolve its storage format and computation engine, but those changes must preserve recoverability. A failed release should be reversible.

## Atomicity in the database

Volodyslav tries to avoid exposing half-applied durable state.

Many operations update several records that only make sense together. In the incremental graph, for example, values, freshness, inputs, reverse dependencies, counters, timestamps, and semantic-key-to-identifier mappings together describe one logical graph state. Publishing only some of those records can create a database that is syntactically readable but semantically inconsistent.

Release-safe persistence code should therefore preserve atomicity at the level of the logical operation, not merely at the level of an individual key-value write.

This includes several concrete practices:

* stage writes before publication;
* flush durable writes before updating volatile in-memory mirrors;
* avoid exposing newly allocated identifiers before their persisted lookup exists;
* write candidate merged state into an inactive replica before changing the active pointer;
* rebuild derived indexes from authoritative records rather than treating them as independent sources of truth;
* fail loudly when required metadata is missing, malformed, or contradictory.

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

## Release-blocker markers

Some unsafe states are useful to keep in the repository temporarily while a larger change is being developed. For those cases, Volodyslav uses explicit release-blocker markers.

A release-blocker marker is a unique string placed next to a known unresolved release-safety issue:

```text
THIS-MARKER-BLOCKS-VOLODYSLAV-RELEASE-63461325
```

The install path scans tracked files for this marker. If the marker is present, installation fails and reports the matching locations.

This is intentionally stronger than a comment. A comment informs a reader; a release-blocker marker changes program behavior. It turns a known unsafe repository state into an executable guardrail.

For non-release CI or installation tests, the blocker may be bypassed explicitly with an environment variable. The bypass is explicit because “running on CI” does not by itself mean “safe to ignore release blockers.”

## Build, test, and static checks

Builds, tests, linting, and type checking are part of release safety, but they are not the whole policy.

They help catch implementation errors before installation. They are especially important for persistence code, migration code, synchronization code, and filesystem rendering code, where small regressions can affect durable state.

However, passing tests does not automatically mean a release is safe. Known unresolved correctness issues still require release blockers, and durable-state changes still require rollback and migration planning.

## Policy

A change that affects durable state, synchronization, migration, installation, or generated graph state should answer these questions:

1. What persisted state can this change read or write?
2. Can a failure leave active state partially updated?
3. Is there a checkpoint or rollback path?
4. Does the stored format have version metadata?
5. Are migrations explicit?
6. Is incoming synchronized state staged before publication?
7. Are metadata invariants validated?
8. Are known unresolved correctness issues marked as release blockers?
9. Can installation accidentally proceed while a blocker remains?

Release safety is not one mechanism. It is the combination of rollback, explicit formats, atomic database publication, staging, validation, tests, and install-time guards.
