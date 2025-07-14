const workingRepository = require("../gitstore/working_repository");

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
    const remoteLocation = { url: remotePath };
    return await workingRepository.synchronize(capabilities, workingPath, remoteLocation);
}

/**
 * Ensures the event log repository is accessible locally.
 * This is a specialized wrapper around workingRepository.getRepository
 * with the standard event log repository parameters.
 * @param {Capabilities} capabilities
 * @returns {Promise<string>} The path to the .git directory
 */
async function ensureAccessible(capabilities) {
    const workingPath = "working-git-repository";
    const remotePath = capabilities.environment.eventLogRepository();
    const remoteLocation = { url: remotePath };
    return await workingRepository.getRepository(capabilities, workingPath, remoteLocation);
}

module.exports = { synchronize, ensureAccessible };
