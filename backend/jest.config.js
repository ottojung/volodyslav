module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  globalTeardown: '<rootDir>/jest.teardown.js',
};