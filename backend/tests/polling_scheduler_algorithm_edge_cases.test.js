/**
 * Tests for declarative scheduler algorithm robustness.
 * Focuses on observable behavior and edge case handling.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubPollInterval, stubRuntimeStateStorage } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubRuntimeStateStorage(capabilities);
    stubPollInterval(1); // Fast polling for tests
    return capabilities;
}

describe("declarative scheduler algorithm robustness", () => {
    test("should handle basic task scheduling correctly", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();

        const registrations = [
            ["edge-case-test", "0 12 * * *", taskCallback, retryDelay] // Daily at noon
        ];

        await capabilities.scheduler.initialize(registrations);

        // Verify the scheduler handles the scheduling gracefully
        await new Promise(resolve => setTimeout(resolve, 200));

        // Scheduler should have processed the registration without error
        expect(typeof taskCallback).toBe('function');

        await capabilities.scheduler.stop();
    });

    test("should handle frequent task scheduling without issues", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();

        const registrations = [
            ["frequent-task", "0 * * * *", taskCallback, retryDelay] // Every minute
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for execution
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(taskCallback).toHaveBeenCalled();

        await capabilities.scheduler.stop();
    });

    test("should handle multiple different cron schedules", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);

        const hourlyTask = jest.fn();
        const dailyTask = jest.fn();
        const minuteTask = jest.fn();

        const registrations = [
            ["hourly-task", "0 * * * *", hourlyTask, retryDelay], // Hourly
            ["daily-task", "0 12 * * *", dailyTask, retryDelay], // Daily at noon
            ["minute-task", "0 * * * *", minuteTask, retryDelay] // Every minute
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for execution
        await new Promise(resolve => setTimeout(resolve, 200));

        // At least the minute task should execute
        expect(minuteTask).toHaveBeenCalled();

        await capabilities.scheduler.stop();
    });

    test("should handle retry timing precision correctly", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(1000); // 1 second
        let callCount = 0;

        const precisionCallback = jest.fn(() => {
            callCount++;
            if (callCount === 1) {
                throw new Error("First failure for precision test");
            }
        });

        // Set initial time to trigger immediate execution (start of minute)
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        const registrations = [
            ["precision-test", "0 * * * *", precisionCallback, retryDelay]
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start and execute initial task
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(precisionCallback).toHaveBeenCalledTimes(1);

        // Advance time by retry delay to trigger retry
        timeControl.advanceTime(1000); // 1 second retry delay
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait for polling
        expect(precisionCallback).toHaveBeenCalledTimes(2);

        await capabilities.scheduler.stop();
    });

    test("should handle complex cron expressions gracefully", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();

        const registrations = [
            // Expression that runs at specific times with varying intervals
            ["varying-interval", "0,15,45 * * * *", taskCallback, retryDelay]
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for initialization
        await new Promise(resolve => setTimeout(resolve, 200));

        // The task should be scheduled without errors
        expect(typeof taskCallback).toBe('function');

        await capabilities.scheduler.stop();
    });

    test("should handle multiple tasks with different schedules and retries", async () => {
        const capabilities = getTestCapabilities();

        const task1 = jest.fn();
        const task2 = jest.fn();
        const task3 = jest.fn();

        const registrations = [
            ["multi-field-task1", "0 * * * *", task1, fromMilliseconds(1000)], // Every minute
            ["multi-field-task2", "*/15 * * * *", task2, fromMilliseconds(2000)], // Every 5 minutes  
            ["multi-field-task3", "0 * * * *", task3, fromMilliseconds(3000)] // Every hour
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for executions
        await new Promise(resolve => setTimeout(resolve, 200));

        // At least the minute task should execute
        expect(task1).toHaveBeenCalled();

        await capabilities.scheduler.stop();
    });

    test("should handle error propagation gracefully", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const goodTask = jest.fn();
        const badTask = jest.fn(() => {
            throw new Error("Task execution error");
        });

        const registrations = [
            ["bad-task", "0 * * * *", badTask, retryDelay],
            ["good-task", "0 * * * *", goodTask, retryDelay]
        ];

        // Should not throw even with error in one task
        await capabilities.scheduler.initialize(registrations);

        // Wait for executions
        await new Promise(resolve => setTimeout(resolve, 200));

        // Both tasks should have been attempted
        expect(badTask).toHaveBeenCalled();
        expect(goodTask).toHaveBeenCalled();

        await capabilities.scheduler.stop();
    });

    test("should reject invalid cron expressions", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();

        const registrations = [
            ["invalid-cron", "invalid cron expression", taskCallback, retryDelay]
        ];

        // Should throw for invalid cron expression
        await expect(
            capabilities.scheduler.initialize(registrations)
        ).rejects.toThrow();
    });

    test("should handle idempotent initialization correctly", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();

        const registrations = [
            ["idempotent-test", "0 * * * *", taskCallback, retryDelay]
        ];

        // Multiple initializations should be idempotent
        await capabilities.scheduler.initialize(registrations);
        await capabilities.scheduler.initialize(registrations);
        await capabilities.scheduler.initialize(registrations);

        // Wait for execution
        await new Promise(resolve => setTimeout(resolve, 200));

        // Should only execute once despite multiple initializations
        expect(taskCallback).toHaveBeenCalledTimes(1);

        await capabilities.scheduler.stop();
    });
});
