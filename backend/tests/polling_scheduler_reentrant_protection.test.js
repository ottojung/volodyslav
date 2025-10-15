/**
 * Tests for declarative scheduler re-entrancy protection.
 * Ensures proper guarding against overlapping scheduler operations.
 */

const { fromHours, fromMilliseconds, fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubScheduler, getSchedulerControl, getDatetimeControl, stubRuntimeStateStorage } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubRuntimeStateStorage(capabilities);
    stubScheduler(capabilities);
    return capabilities;
}

describe("declarative scheduler re-entrancy protection", () => {
    test("should reject concurrent initialize calls", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(fromMilliseconds(100));
        const retryDelay = fromMilliseconds(5000);

        // Set time to avoid immediate execution for "0 * * * *" schedule
        const startTime = fromISOString("2021-01-01T00:05:00.000Z");
        timeControl.setDateTime(startTime);
        
        // Create a simple task
        const simpleTask = jest.fn().mockResolvedValue(undefined);
        
        const registrations = [
            ["simple-task", "0 * * * *", simpleTask, retryDelay]
        ];
        
        // Call initialize multiple times concurrently - should throw error
        const promises = [
            capabilities.scheduler.initialize(registrations),
            capabilities.scheduler.initialize(registrations),
            capabilities.scheduler.initialize(registrations),
        ];
        
        // At least one should fail with SchedulerAlreadyActiveError
        const results = await Promise.allSettled(promises);
        const rejectedResults = results.filter(r => r.status === "rejected");
        expect(rejectedResults.length).toBeGreaterThan(0);
        expect(rejectedResults[0].reason.name).toBe("SchedulerAlreadyActiveError");
        
        await capabilities.scheduler.stop();
    });

    test("should reject multiple initialize calls when already running", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(fromMilliseconds(100));
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        let taskExecutionCount = 0;
        
        const quickTask = jest.fn(() => {
            taskExecutionCount++;
        });
        
        // Set time to avoid immediate execution for "0 * * * *" schedule
        const startTime = fromISOString("2021-01-01T00:05:00.000Z");
        timeControl.setDateTime(startTime);
        
        const registrations = [
            ["quick-task", "0 * * * *", quickTask, retryDelay]
        ];
        
        // First initialize call
        await capabilities.scheduler.initialize(registrations);

        // Subsequent calls should throw
        await expect(capabilities.scheduler.initialize(registrations)).rejects.toThrow("Cannot initialize scheduler: scheduler is already running");
        await expect(capabilities.scheduler.initialize(registrations)).rejects.toThrow("Cannot initialize scheduler: scheduler is already running");
        await expect(capabilities.scheduler.initialize(registrations)).rejects.toThrow("Cannot initialize scheduler: scheduler is already running");

        // Should NOT execute immediately on first startup
        await schedulerControl.waitForNextCycleEnd();
        expect(taskExecutionCount).toBe(0);

        // Advance to next scheduled execution (01:00:00)
        timeControl.advanceByDuration(fromHours(1)); // 1 hour
        await schedulerControl.waitForNextCycleEnd();
        
        expect(taskExecutionCount).toBe(1);

        await schedulerControl.waitForNextCycleEnd();
        
        // Task should not execute again without advancing time
        expect(taskExecutionCount).toBe(1);
        
        await capabilities.scheduler.stop();
    });

    test("should reject initialize calls after initialization", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(fromMilliseconds(100));
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        let taskExecutionCount = 0;
        
        const quickTask = jest.fn(() => {
            taskExecutionCount++;
        });
        
        // Set time to avoid immediate execution for "0 * * * *" schedule
        const startTime = fromISOString("2021-01-01T00:05:00.000Z");
        timeControl.setDateTime(startTime);
        
        const registrations = [
            ["quick-task", "0 * * * *", quickTask, retryDelay]
        ];
        
        // First initialize call
        await capabilities.scheduler.initialize(registrations);

        // Should NOT execute immediately on first startup
        await schedulerControl.waitForNextCycleEnd();
        expect(taskExecutionCount).toBe(0);

        // Advance to next scheduled execution (01:00:00)
        timeControl.advanceByDuration(fromHours(1)); // 1 hour
        await schedulerControl.waitForNextCycleEnd();
        
        expect(taskExecutionCount).toBe(1);
        
        // Second initialize call should throw error (not idempotent anymore)
        await expect(capabilities.scheduler.initialize(registrations)).rejects.toThrow("Cannot initialize scheduler: scheduler is already running");
        await schedulerControl.waitForNextCycleEnd();
        
        // Task should not execute again on rejected call
        expect(taskExecutionCount).toBe(1);
        
        await capabilities.scheduler.stop();
    });

    test("should reject initialize after errors during task execution", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(fromMilliseconds(100));
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(5000);
        let taskExecutionCount = 0;
        
        const errorTask = jest.fn(() => {
            taskExecutionCount++;
            throw new Error("Task execution fails");
        });
        
        // Set time to avoid immediate execution for "0 * * * *" schedule
        const startTime = fromISOString("2021-01-01T00:05:00.000Z");
        timeControl.setDateTime(startTime);
        
        const registrations = [
            ["error-task", "0 * * * *", errorTask, retryDelay]
        ];
        
        // Should not throw despite task errors
        await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();
        
        // Wait for scheduler initialization
        await schedulerControl.waitForNextCycleEnd();
        
        // Should NOT execute immediately on first startup
        expect(taskExecutionCount).toBe(0);
        
        // Advance to next scheduled execution (01:00:00)
        timeControl.advanceByDuration(fromHours(1)); // 1 hour
        await schedulerControl.waitForNextCycleEnd();
        
        expect(taskExecutionCount).toBe(1);
        
        // Should NOT allow subsequent initialize calls (no longer idempotent)
        await expect(capabilities.scheduler.initialize(registrations)).rejects.toThrow("Cannot initialize scheduler: scheduler is already running");
        
        await capabilities.scheduler.stop();
    });

    test("should reject different registrations when already running", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        
        const validTask = jest.fn().mockResolvedValue(undefined);
        
        const registrations = [
            ["valid-task", "0 * * * *", validTask, retryDelay]
        ];
        
        // First call to establish state
        await capabilities.scheduler.initialize(registrations);
        
        // Different registrations should now throw error instead of overriding
        const differentRegistrations = [
            ["different-task", "0 * * * *", validTask, retryDelay]
        ];
        
        // This should now throw error (no override behavior)
        await expect(capabilities.scheduler.initialize(differentRegistrations))
            .rejects.toThrow("Cannot initialize scheduler: scheduler is already running");
        
        await capabilities.scheduler.stop();
    });
});