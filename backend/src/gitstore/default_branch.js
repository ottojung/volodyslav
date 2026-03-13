/** @typedef {import('../environment').Environment} Environment */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment
 */

/**
 * @param {Capabilities} capabilities
 * @returns {string}
 */
function defaultBranch(capabilities) {
    return `${capabilities.environment.hostname()}-main`;
}

module.exports = defaultBranch;
