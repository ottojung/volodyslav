/**
 * Jest Projects
 * The single list of Jest projects in this repository, consumed by
 * `jest.config.js` and asserted by `jest_global_setup.js`.
 */

/** @type {string[]} */
const PROJECT_CONFIG_PATHS = [
    "<rootDir>/backend/jest.config.js",
    "<rootDir>/frontend/jest.config.js",
];

/**
 * Project config paths resolved against the repository root.
 *
 * @returns {string[]} Absolute paths Jest can `require` directly.
 */
function resolvedProjectConfigPaths() {
    return PROJECT_CONFIG_PATHS.map((entry) => entry.replace("<rootDir>", __dirname));
}

module.exports = { PROJECT_CONFIG_PATHS, resolvedProjectConfigPaths };