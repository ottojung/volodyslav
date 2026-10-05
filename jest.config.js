/**
 * Jest Configuration
 * Runs the backend and frontend projects.
 *
 * Jest's circus runner takes the per-test timeout budget from `globalConfig`,
 * which in a `projects` configuration is the root config. Root-level options are
 * not merged down into the projects named here, so the root `testTimeout` is the
 * only placement that changes the effective budget. `jest_global_setup.js`
 * asserts that the root value and every project value all match the request.
 */
const { PROJECT_CONFIG_PATHS } = require("./jest_projects");
const { resolveTestTimeout } = require("./jest_test_timeout");

module.exports = {
  projects: PROJECT_CONFIG_PATHS,
  testTimeout: resolveTestTimeout(process.env),
  globalSetup: '<rootDir>/jest_global_setup.js',
};