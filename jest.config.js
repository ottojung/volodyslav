/**
 * Jest Configuration
 * Runs tests in both backend and frontend workspaces.
 */
module.exports = {
  projects: [
    '<rootDir>/backend',
    '<rootDir>/frontend/jest.config.js'
  ]
};