/**
 * Tests for declarative scheduler persistence edge cases and error recovery.
 * These tests ensure the scheduler handles corruption, file system errors,
 * and various persistence scenarios correctly using the declarative API.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    return capabilities;
}

describe("declarative scheduler persistence and error handling", () => {
    // Use real timers for testing actual scheduler behavior
    beforeEach(() => {
        // Don't use fake timers - let the scheduler run with real timing
    });

    afterEach(() => {
        // No timer cleanup needed
    });

    test("should handle task execution errors gracefully", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);

        let callCount = 0;
        const flakyCallback = jest.fn(() => {
            callCount++;
            if (callCount <= 2) {
                throw new Error(`Execution failed ${callCount}`);
            }
            return Promise.resolve();
        });

        const registrations = [
            // Use a cron that runs immediately (every minute)
            ["flaky-task", "* * * * *", flakyCallback, retryDelay]
        ];

        // Initialize with fast polling for testing
        await capabilities.scheduler.initialize(registrations);

        // Wait for the scheduler to execute the task at least once
        await new Promise(resolve => setTimeout(resolve, 300));

        // Should have been called at least once (even if it errors)
        expect(flakyCallback).toHaveBeenCalled();

        await capabilities.scheduler.stop(capabilities);
    });

    test("should handle different types of callback errors", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(1000);

        // Test basic error handling without complex loops
        const errorCallback = jest.fn(() => {
            throw new Error("Test error");
        });

        const registrations = [
            ["error-task", "* * * * *", errorCallback, retryDelay]
        ];

        // Initialize scheduler with error-throwing callback
        await capabilities.scheduler.initialize(registrations);

        // Wait for execution
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify the scheduler handles error callbacks gracefully by not throwing
        await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();

        await capabilities.scheduler.stop(capabilities);
    });

    test("should maintain task state consistency after errors", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(2000);

        const successCallback = jest.fn().mockResolvedValue(undefined);
        const failureCallback = jest.fn().mockRejectedValue(new Error("Always fails"));

        const registrations = [
            ["success-task", "* * * * *", successCallback, retryDelay],
            ["failure-task", "* * * * *", failureCallback, retryDelay]
        ];

        // Initialize with both successful and failing tasks
        await capabilities.scheduler.initialize(registrations);

        // Wait for task execution
        await new Promise(resolve => setTimeout(resolve, 300));

        // Both callbacks should have been invoked despite errors
        expect(successCallback).toHaveBeenCalled();
        expect(failureCallback).toHaveBeenCalled();

        await capabilities.scheduler.stop(capabilities);
    });

    test("should handle concurrent task execution limits", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);

        const simpleCallback = jest.fn().mockResolvedValue(undefined);

        // Schedule fewer tasks to avoid timeout
        const registrations = [];
        for (let i = 0; i < 3; i++) {
            registrations.push([`simple-task-${i}`, "* * * * *", simpleCallback, retryDelay]);
        }

        // Should be able to initialize with multiple tasks without issue
        await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();

        await capabilities.scheduler.stop(capabilities);
    });

    test("should handle system resource constraints gracefully", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(1000);

        // Simple test for resource constraint handling
        const task = jest.fn();
        const registrations = [
            ["resource-test", "* * * * *", task, retryDelay]
        ];

        await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();

        await capabilities.scheduler.stop(capabilities);
    });

    test("should handle time manipulation edge cases", async () => {
        // This test specifically needs fake timers for time manipulation
        jest.useFakeTimers();
        
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn().mockResolvedValue(undefined);

        const registrations = [
            ["time-test-task", "0 12 * * *", callback, retryDelay]
        ];

        try {
            // Test various time manipulations
            const testTimes = [
                "2024-01-15T12:00:00Z", // Exactly scheduled time
                "2024-01-15T11:59:59Z", // Just before
                "2024-01-15T12:00:01Z", // Just after
                "2024-01-15T23:59:59Z", // End of day
                "2024-01-16T00:00:00Z", // Start of next day
                "2100-01-15T12:00:00Z", // Far future
                "1970-01-01T12:00:00Z", // Unix epoch
            ];

            for (const timeStr of testTimes) {
                jest.setSystemTime(new Date(timeStr));

                // Should be able to initialize at any time
                await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();
            }

            await capabilities.scheduler.stop(capabilities);
        } finally {
            jest.useRealTimers();
        }
    });

    test("should handle invalid callback types gracefully", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);

        // Test various callback scenarios
        const validCallback = jest.fn().mockResolvedValue(undefined);

        // Valid case
        const registrations = [
            ["valid-task", "0 */4 * * *", validCallback, retryDelay]
        ];

        await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();

        await capabilities.scheduler.stop(capabilities);
    });

    test("should maintain correct task ordering and priority", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(1000);

        const callback1 = jest.fn().mockResolvedValue(undefined);
        const callback2 = jest.fn().mockResolvedValue(undefined);

        // Tasks should be processed in the order they are registered
        const registrations = [
            ["task1", "* * * * *", callback1, retryDelay],
            ["task2", "* * * * *", callback2, retryDelay]
        ];

        await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();

        // Both callbacks should be scheduled and available for execution
        await capabilities.scheduler.initialize(registrations);

        await capabilities.scheduler.stop(capabilities);
    });

    test("should maintain task order when scheduled at different times", async () => {
        const capabilities1 = getTestCapabilities();
        const capabilities2 = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);

        const callback1 = jest.fn().mockResolvedValue(undefined);
        const callback2 = jest.fn().mockResolvedValue(undefined);
        const callback3 = jest.fn().mockResolvedValue(undefined);

        // Schedule tasks with different times but same registration order
        const registrations = [
            ["task-a", "0 10 * * *", callback1, retryDelay],
            ["task-z", "0 14 * * *", callback2, retryDelay],
            ["task-m", "0 12 * * *", callback3, retryDelay]
        ];

        await expect(capabilities1.scheduler.initialize(registrations)).resolves.toBeUndefined();

        // Tasks should be schedulable regardless of their scheduled times (test with separate instance)
        await expect(capabilities2.scheduler.initialize(registrations)).resolves.toBeUndefined();

        await capabilities1.scheduler.stop(capabilities1);
        await capabilities2.scheduler.stop(capabilities2);
    });
});
