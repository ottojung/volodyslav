/**
 * Jest Configuration
 * Runs tests in both backend and frontend workspaces.
 */
module.exports = {
  projects: [
    '<rootDir>/backend/jest.config.js',
    '<rootDir>/frontend/jest.config.js'
  ]
};
