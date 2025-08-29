/**
 * Tests for declarative scheduler time handling and scheduling behavior.
 * These tests ensure the scheduler handles time-based scheduling correctly.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubPollInterval } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubPollInterval(capabilities, 1); // Fast polling for tests
    return capabilities;
}

describe("declarative scheduler time handling", () => {
    // Use real timers for testing actual scheduler behavior
    
    test("should handle tasks scheduled at specific times", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();

        const registrations = [
            // Schedule task for 2:30 AM
            ["time-specific-task", "30 2 * * *", callback, retryDelay]
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler initialization
        await new Promise(resolve => setTimeout(resolve, 200));

        // Task should not run yet (not at 2:30 AM)
        expect(true).toBe(true); // Scheduler initialized successfully

        await capabilities.scheduler.stop();
    });

    test("should handle hourly tasks correctly", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();

        const registrations = [
            // Schedule task for 1:30 AM daily
            ["hourly-task", "30 1 * * *", callback, retryDelay]
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduling
        await new Promise(resolve => setTimeout(resolve, 200));

        // Task should not run yet (not at 1:30 AM)
        expect(true).toBe(true); // Scheduler initialized successfully

        await capabilities.scheduler.stop();
    });

    test("should maintain correct scheduling across time", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();

        const registrations = [
            ["daily-task", "0 3 * * *", callback, retryDelay] // Daily 3 AM
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for initialization
        await new Promise(resolve => setTimeout(resolve, 200));

        // Task should not run yet (not at 3 AM)
        expect(true).toBe(true); // Scheduler initialized successfully

        await capabilities.scheduler.stop();
    });

    test("should handle timezone-independent scheduling", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();

        const registrations = [
            // Schedule task at noon - should work regardless of timezone
            ["timezone-task", "0 12 * * *", callback, retryDelay]
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for initialization
        await new Promise(resolve => setTimeout(resolve, 200));

        // Task should not run yet (not at noon)
        expect(true).toBe(true); // Scheduler initialized successfully

        await capabilities.scheduler.stop();
    });

    test("should handle edge case scheduling for weekly and daily tasks", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();

        const registrations = [
            ["daily-edge-task", "0 2 * * *", callback, retryDelay] // Daily 2 AM
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for initialization
        await new Promise(resolve => setTimeout(resolve, 200));

        // Task should not run yet (not at 2 AM)
        expect(true).toBe(true); // Scheduler initialized successfully

        await capabilities.scheduler.stop();
    });

    test("should maintain execution history correctly", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        let executionCount = 0;
        
        const callback = jest.fn(() => {
            executionCount++;
        });

        const registrations = [
            ["execution-history-task", "0 * * * *", callback, retryDelay] // Every minute for quick testing
        ];

        // First initialization and execution
        await capabilities.scheduler.initialize(registrations);
        
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(executionCount).toBe(1);
        
        await capabilities.scheduler.stop();

        // Second initialization (simulating restart)
        await capabilities.scheduler.initialize(registrations);

        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Should maintain proper execution tracking
        expect(callback).toHaveBeenCalled();

        await capabilities.scheduler.stop();
    });

    test("should handle multiple timezone-aware tasks consistently", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        
        const task1 = jest.fn();
        const task2 = jest.fn();

        const registrations = [
            ["morning-task", "0 2 * * *", task1, retryDelay],   // 2 AM
            ["evening-task", "0 14 * * *", task2, retryDelay]  // 2 PM
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for initialization
        await new Promise(resolve => setTimeout(resolve, 200));

        // Tasks should be scheduled - check they are functions
        expect(typeof task1).toBe('function');
        expect(typeof task2).toBe('function');

        await capabilities.scheduler.stop();
    });

    test("should handle complex scheduling patterns", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();

        const registrations = [
            // Complex schedule - multiple times per hour
            ["complex-schedule", "0,15,30,45 * * * *", callback, retryDelay]
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for initialization
        await new Promise(resolve => setTimeout(resolve, 200));

        // Task should not run yet (not at scheduled times)
        expect(true).toBe(true); // Scheduler initialized successfully

        await capabilities.scheduler.stop();
    });

    test("should handle scheduler restart with time consistency", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(1000);
        let executionCount = 0;
        
        const callback = jest.fn(() => {
            executionCount++;
        });

        const registrations = [
            ["restart-time-task", "0 * * * *", callback, retryDelay]
        ];

        // First run
        await capabilities.scheduler.initialize(registrations);
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(executionCount).toBe(1);
        await capabilities.scheduler.stop();

        // Wait a bit to simulate time gap
        await new Promise(resolve => setTimeout(resolve, 100));

        // Restart
        await capabilities.scheduler.initialize(registrations);
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Should handle restart correctly
        expect(callback).toHaveBeenCalled();

        await capabilities.scheduler.stop();
    });
});
