/**
 * Snapshot compatibility.
 *
 * `incremental-graph-journal-sync.md` §Snapshot compatibility cut makes one held
 * source snapshot the sole authority on whether the two databases describe the
 * same thing: `databaseVersion` and `graphSchemeString` must match the receiver's
 * active values exactly, and earlier mutable metadata is not sufficient.
 * Synchronization never migrates, so a mismatch is reported rather than resolved.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */

const { makeJournalVersionCompatibilityError } = require("../journal");

/**
 * The properties that this class carries are:
 * - both values came from one held snapshot of one database, so a later change to
 *   that database cannot make them disagree with each other.
 *
 * The proof of those properties is guaranteed by:
 * - `makeSnapshotIdentity(...)`: it is the only function which produces this type,
 *   and it takes both values as arguments of one call rather than reading them
 *   separately.
 *
 * @param {string} databaseVersion
 * @param {string} graphSchemeString
 */
class SnapshotIdentityClass {
    /**
     * @param {string} databaseVersion
     * @param {string} graphSchemeString
     */
    constructor(databaseVersion, graphSchemeString) {
        this.databaseVersion = databaseVersion;
        this.graphSchemeString = graphSchemeString;
    }
}

/** @typedef {SnapshotIdentityClass} SnapshotIdentity */

/**
 * @param {unknown} value
 * @returns {value is SnapshotIdentity}
 */
function isSnapshotIdentity(value) {
    return value instanceof SnapshotIdentityClass;
}

/**
 * Require exact identity between the held source snapshot and the receiver's
 * active values.
 *
 * @param {SnapshotIdentity} receiver
 * @param {SnapshotIdentity} source
 * @returns {JournalError | undefined}
 */
function assertCompatibleIdentity(receiver, source) {
    if (receiver.databaseVersion !== source.databaseVersion) {
        return makeJournalVersionCompatibilityError(
            "the held source snapshot declares a different database version than the receiver",
            receiver.databaseVersion,
            source.databaseVersion
        );
    }
    if (receiver.graphSchemeString !== source.graphSchemeString) {
        return makeJournalVersionCompatibilityError(
            "the held source snapshot declares a different graph scheme than the receiver",
            receiver.databaseVersion,
            source.databaseVersion
        );
    }
    return undefined;
}

module.exports = {
    SnapshotIdentityClass,
    assertCompatibleIdentity,
    isSnapshotIdentity,
};