/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */

/**
 * @typedef {object} Capabilities
 * @property {Command} rsync - A command instance for rsync operations.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 */

class AssetsSynchronizationError extends Error {
    /**
     * @param {string} message
     * @param {unknown} cause
     */
    constructor(message, cause) {
        super(message);
        this.name = "AssetsSynchronizationError";
        this.cause = cause;
    }
}

/**
 * @param {unknown} object
 * @returns {object is AssetsSynchronizationError}
 */
function isAssetsSynchronizationError(object) {
    return object instanceof AssetsSynchronizationError;
}

/**
 * Ensures a path ends with exactly one trailing slash.
 * @param {string} p
 * @returns {string}
 */
function withTrailingSlash(p) {
    return p.replace(/\/+$/, "") + "/";
}

/**
 * Synchronizes the assets directory with the remote repository using rsync.
 * Performs a pull (remote → local) followed by a push (local → remote).
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function synchronize(capabilities) {
    const local = withTrailingSlash(capabilities.environment.eventLogAssetsDirectory());
    const remote = withTrailingSlash(capabilities.environment.eventLogAssetsRepository());

    capabilities.logger.logInfo({ local, remote }, "Synchronizing assets directory");

    async function pull() {
        try {
            // pull: remote → local
            return await capabilities.rsync.call("--recursive", "--partial", "--info=stats2", "--human-readable", "--", remote, local);
        } catch (error) {
            throw new AssetsSynchronizationError(
                `Failed to pull assets from remote: ${error}`,
                error
            );
        }
    }

    async function push() {
        try {
            return await capabilities.rsync.call("--recursive", "--partial", "--info=stats2", "--human-readable", "--", local, remote);
        } catch (error) {
            throw new AssetsSynchronizationError(
                `Failed to push assets to remote: ${error}`,
                error
            );
        }
    }

    const pullResult = await pull();
    const pushResult = await push();

    capabilities.logger.logInfo(
        { pullResult, pushResult },
        "Assets directory synchronized successfully"
    );
}

module.exports = { synchronize, isAssetsSynchronizationError };
