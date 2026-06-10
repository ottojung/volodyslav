/**
 * Jest Configuration
 * Runs tests in both backend and frontend workspaces.
 */
module.exports = {
  projects: [
    '<rootDir>/backend',
    '<rootDir>/frontend/jest.config.js'
  ]
  testTimeout: Number(process.env.JEST_TEST_TIMEOUT ?? 5000),
};
