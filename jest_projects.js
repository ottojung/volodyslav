/**
 * Jest Projects
 * The single list of Jest configs in this repository, consumed by
 * `jest.config.js` and asserted by `jest_global_setup.js`.
 */

/** @type {string} */
const ROOT_CONFIG_FILENAME = "jest.config.js";

/** @type {string[]} */
const PROJECT_CONFIG_PATHS = [
    "<rootDir>/backend/jest.config.js",
    "<rootDir>/frontend/jest.config.js",
];

/**
 * The root config path, resolved against the repository root.
 *
 * @returns {string} Absolute path Jest and `jest_global_setup.js` can `require` directly.
 */
function resolvedRootConfigPath() {
    return `${__dirname}/${ROOT_CONFIG_FILENAME}`;
}

/**
 * Project config paths resolved against the repository root.
 *
 * @returns {string[]} Absolute paths Jest can `require` directly.
 */
function resolvedProjectConfigPaths() {
    return PROJECT_CONFIG_PATHS.map((entry) => entry.replace("<rootDir>", __dirname));
}

module.exports = {
    ROOT_CONFIG_FILENAME,
    PROJECT_CONFIG_PATHS,
    resolvedRootConfigPath,
    resolvedProjectConfigPaths,
};
