/**
 * The failure a held snapshot reports when it cannot be restored from.
 *
 * The class lives in its own module because both halves of the restoration need
 * it and neither may require the other: the snapshot reader reports what a
 * snapshot cannot supply, and the restorer reports what it cannot lower.
 */

/**
 * Thrown when a held snapshot cannot be restored as an absent installation.
 *
 * The properties this class carries are:
 * - `reason` names which part of the snapshot could not be read or lowered, so
 *   a caller can report a source which cannot deliver what it reported rather
 *   than treating the failure as absence.
 *
 * The proof of those properties is guaranteed by:
 * - `restoreAbsentFrom(...)` and `readHeldSnapshot(...)`: each `reason` they
 *   report is produced by exactly one of the reads or lowerings they perform.
 *
 * @param {string} reason
 * @param {string} snapshotPath
 */
class AbsentRestoreError extends Error {
    /**
     * @param {string} reason
     * @param {string} snapshotPath
     */
    constructor(reason, snapshotPath) {
        super(
            'Cannot restore the absent installation from the held snapshot: ' +
            reason + ' (' + snapshotPath + ')'
        );
        this.name = 'AbsentRestoreError';
        this.reason = reason;
        this.snapshotPath = snapshotPath;
    }
}

/**
 * @param {unknown} object
 * @returns {object is AbsentRestoreError}
 */
function isAbsentRestoreError(object) {
    return object instanceof AbsentRestoreError;
}

module.exports = {
    AbsentRestoreError,
    isAbsentRestoreError,
};
