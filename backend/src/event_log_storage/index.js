const workingRepository = require("../gitstore/working_repository");
const { transaction } = require("./transaction");

/** @typedef {import('../gitstore/working_repository').Capabilities} Capabilities */

/**
 * Synchronizes the event log repository with the remote.
 * This is a specialized wrapper around workingRepository.synchronize
 * with the standard event log repository parameters.
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function synchronize(capabilities) {
    const workingPath = "working-git-repository";
    const remotePath = capabilities.environment.eventLogRepository();
    return await workingRepository.synchronize(capabilities, workingPath, remotePath);
}

module.exports = { transaction, synchronize };
