
class SynchronizeDatabaseError extends Error {
    /**
     * @param {unknown} synchronizeCause
     * @param {unknown} reopenCause
     */
    constructor(synchronizeCause, reopenCause) {
        super(
            `Interface database sync failed: ${synchronizeCause}; reopening database failed: ${reopenCause}`
        );
        this.name = "SynchronizeDatabaseError";
        this.synchronizeCause = synchronizeCause;
        this.reopenCause = reopenCause;
    }
}

/**
 * Type guard for SynchronizeDatabaseError.
 * @param {unknown} object
 * @returns {object is SynchronizeDatabaseError}
 */
function isSynchronizeDatabaseError(object) {
    return object instanceof SynchronizeDatabaseError;
}

/**
 * Factory for SynchronizeDatabaseError.
 * @param {unknown} synchronizeCause
 * @param {unknown} reopenCause
 * @returns {SynchronizeDatabaseError}
 */
function makeSynchronizeDatabaseError(synchronizeCause, reopenCause) {
    return new SynchronizeDatabaseError(synchronizeCause, reopenCause);
}

module.exports = {
    makeSynchronizeDatabaseError,
    isSynchronizeDatabaseError,
};
