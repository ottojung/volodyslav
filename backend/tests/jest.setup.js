/**
 * Jest setup file for backend tests
 * This file is run before each test file
 */

// Global cleanup for scheduler timers
afterEach(() => {
  // Check if any test capabilities have a stubbed scheduler with pending timers
  global.stubTimerCleanupFunctions = global.stubTimerCleanupFunctions || [];
  
  // Clean up any timers created by stubbed schedulers
  global.stubTimerCleanupFunctions.forEach(cleanup => {
    try {
      cleanup();
    } catch (error) {
      // Ignore cleanup errors - they're not critical
    }
  });
  
  // Clear the cleanup functions array
  global.stubTimerCleanupFunctions = [];
});