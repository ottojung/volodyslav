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
 * records to retain. Nothing here touches storage.
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
    projectWithRecords,
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
    projectWithRecords,
    synchronizeRetainedJournal,
};