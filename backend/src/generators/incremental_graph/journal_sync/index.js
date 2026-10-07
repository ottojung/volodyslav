/**
 * The synchronization subfolder's encapsulation point.
 *
 * This module is the only import point of `journal_sync`. A caller outside this
 * subfolder reaches synchronization through `synchronizeRetainedJournal` and the
 * synchronization result, and through the small set of guards and types which
 * describe that result. The passes themselves stay private, so a caller cannot
 * import one phase and skip the ordering the specification gives it.
 *
 * `synchronizeRetainedJournal` performs everything up to but excluding the
 * publication write: it acquires the missing foreign-writer suffixes, validates
 * what it admits, computes the normalization the union still owes, allocates the
 * receiver-authored records, and returns `project(Jfinal)` together with the
 * records to retain and the retained replay state of `Jfinal`. Nothing here
 * touches storage.
 *
 * A caller supplies that state, because `incremental-graph-journal-storage.md`
 * §Change-bounded proof summary forbids synchronization from scanning retained
 * history to obtain it, and §Derived indexes requires a maintained index to be
 * updated in durable staging before the state it describes becomes active. Both
 * live in `../journal_retained`, which synchronization reaches only through its
 * own index.
 */

/** @typedef {import('./authoring').SyncDeleteRequest} SyncDeleteRequest */
/** @typedef {import('./authoring').SyncInvalidateRequest} SyncInvalidateRequest */
/** @typedef {import('./authoring').SyncPublication} SyncPublication */
/** @typedef {import('./normalize').ClosureRemoval} ClosureRemoval */
/** @typedef {import('./normalize').StalePropagation} StalePropagation */
/** @typedef {import('./compatibility').SnapshotIdentity} SnapshotIdentity */
/** @typedef {import('./import_plan').ImportPlan} ImportPlan */
/** @typedef {import('./synchronize').SyncOutcome} SyncOutcome */

const {
    assertCompatibleIdentity,
    isSnapshotIdentity,
    SnapshotIdentityClass,
} = require("./compatibility");
const {
    finalizeSyncRecords,
    isSyncPublication,
    SyncPublicationClass,
} = require("./authoring");
const {
    importedSourceOf,
    ImportedSuffixClass,
    ImportPlanClass,
    isImportPlan,
    planForeignSuffixImport,
} = require("./import_plan");
const {
    isClosureRemoval,
    isStalePropagation,
    planDependencyClosureRemoval,
    planStalePropagation,
} = require("./normalize");
const {
    isSyncOutcome,
    synchronizeRetainedJournal,
    SyncOutcomeClass,
} = require("./synchronize");

module.exports = {
    ImportedSuffixClass,
    ImportPlanClass,
    SnapshotIdentityClass,
    SyncOutcomeClass,
    SyncPublicationClass,
    assertCompatibleIdentity,
    finalizeSyncRecords,
    importedSourceOf,
    isClosureRemoval,
    isImportPlan,
    isSnapshotIdentity,
    isStalePropagation,
    isSyncOutcome,
    isSyncPublication,
    planDependencyClosureRemoval,
    planForeignSuffixImport,
    planStalePropagation,
    synchronizeRetainedJournal,
};