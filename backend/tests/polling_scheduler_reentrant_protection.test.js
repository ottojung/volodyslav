/**
 * Tests for declarative scheduler re-entrancy protection.
 * Ensures proper guarding against overlapping scheduler operations.
 */

const { Duration } = require("luxon");
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
    test("should handle concurrent initialize calls gracefully", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(fromMilliseconds(1));
        const retryDelay = Duration.fromMillis(5000);

        // Set time to avoid immediate execution for "0 * * * *" schedule
        const startTime = fromISOString("2021-01-01T00:05:00.000Z");
        timeControl.setDateTime(startTime);

        let taskStartCount = 0;
        let taskEndCount = 0;
        
        // Create a simple task that tracks execution
        const simpleTask = jest.fn(async () => {
            taskStartCount++;
            // Use a simple delay instead of waiting for scheduler cycles
            await new Promise(resolve => setTimeout(resolve, 10));
            taskEndCount++;
        });
        
        const registrations = [
            ["simple-task", "0 * * * *", simpleTask, retryDelay]
        ];
        
        // Call initialize multiple times concurrently
        const promises = [
            capabilities.scheduler.initialize(registrations),
            capabilities.scheduler.initialize(registrations),
            capabilities.scheduler.initialize(registrations),
        ];
        
        await Promise.all(promises);
        
        // Should NOT execute immediately on first startup
        await schedulerControl.waitForNextCycleEnd();
        expect(taskStartCount).toBe(0);
        expect(taskEndCount).toBe(0);

        // Advance to next scheduled execution (01:00:00)
        timeControl.advanceByDuration(fromHours(1)); // 1 hour
        await schedulerControl.waitForNextCycleEnd();
        
        // Give a bit more time for task completion
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Should handle concurrent calls gracefully
        expect(taskStartCount).toBeGreaterThanOrEqual(1);
        expect(taskEndCount).toBeGreaterThanOrEqual(1);
        
        await capabilities.scheduler.stop();
    });

    test("should allow multiple initialize at the start", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(fromMilliseconds(1));
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = Duration.fromMillis(5000);
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
        
        // First initialize calls
        await capabilities.scheduler.initialize(registrations);
        await capabilities.scheduler.initialize(registrations);
        await capabilities.scheduler.initialize(registrations);
        await capabilities.scheduler.initialize(registrations);

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

    test("should allow multiple initialize calls after completion", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(fromMilliseconds(1));
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = Duration.fromMillis(5000);
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
        
        // Second initialize call should be idempotent
        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();
        
        // Task should not execute again on idempotent call
        expect(taskExecutionCount).toBe(1);
        
        await capabilities.scheduler.stop();
    });

    test("should handle errors during task execution gracefully", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(fromMilliseconds(1));
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = Duration.fromMillis(5000);
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
        
        // Should allow subsequent initialize calls despite previous error
        await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();
        
        await capabilities.scheduler.stop();
    });

    test("should handle task validation differences properly", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = Duration.fromMillis(5000);
        
        const validTask = jest.fn().mockResolvedValue(undefined);
        
        const registrations = [
            ["valid-task", "0 * * * *", validTask, retryDelay]
        ];
        
        // First call to establish state
        await capabilities.scheduler.initialize(registrations);
        
        // Different registrations should now override state instead of throwing error
        const differentRegistrations = [
            ["different-task", "0 * * * *", validTask, retryDelay]
        ];
        
        // This should now succeed (override behavior) instead of throwing
        await expect(capabilities.scheduler.initialize(differentRegistrations))
            .resolves.toBeUndefined();
        
        await capabilities.scheduler.stop();
    });
});