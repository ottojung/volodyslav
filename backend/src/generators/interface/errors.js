
/**
 * The Journal 3 canonical bootstrap did not resolve during startup.
 *
 * `incremental-graph-journal-lifecycle.md` §8.2 makes an unresolved publication outcome
 * a startup failure which leaves the supported pre-Journal database selected, so this
 * error is how that outcome reaches the caller: no graph API has been exposed and no
 * local cutover has happened.
 */
class UnresolvedCanonicalBootstrapError extends Error {
    /**
     * @param {string} detail
     */
    constructor(detail) {
        super(`Canonical bootstrap did not resolve; the pre-Journal database stays the active persisted state: ${detail}`);
        this.name = 'UnresolvedCanonicalBootstrapError';
        this.detail = detail;
    }
}

/**
 * Type guard for UnresolvedCanonicalBootstrapError.
 * @param {unknown} object
 * @returns {object is UnresolvedCanonicalBootstrapError}
 */
function isUnresolvedCanonicalBootstrapError(object) {
    return object instanceof UnresolvedCanonicalBootstrapError;
}

/**
 * Factory for UnresolvedCanonicalBootstrapError.
 * @param {string} detail
 * @returns {UnresolvedCanonicalBootstrapError}
 */
function makeUnresolvedCanonicalBootstrapError(detail) {
    return new UnresolvedCanonicalBootstrapError(detail);
}

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
    makeUnresolvedCanonicalBootstrapError,
    isUnresolvedCanonicalBootstrapError,
};
