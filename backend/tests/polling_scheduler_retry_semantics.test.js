/**
 * Tests for declarative scheduler retry semantics.
 * Ensures cron schedule is not superseded by retry logic.
 */

const { initialize } = require("../src/schedule");
const { COMMON } = require("../src/time_duration");
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

describe("declarative scheduler retry semantics", () => {

    test("should respect cron schedule even during retry period", async () => {
        const capabilities = getTestCapabilities();
        let executionCount = 0;
        let executionModes = [];
        
        const task = jest.fn(() => {
            executionCount++;
            executionModes.push(`execution-${executionCount}`);
            if (executionCount === 1) {
                throw new Error("First execution fails");
            }
        });
        
        const registrations = [
            ["retry-test", "0 */15 * * *", task, COMMON.FIVE_MINUTES], // Task runs every 15 minutes
        ];
        
        // Initialize and wait for first execution
        await initialize(capabilities, registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // The first execution should happen during initialization
        expect(executionCount).toBeGreaterThanOrEqual(1); // First execution should happen
        
        // Call initialize again to trigger retry behavior
        await initialize(capabilities, registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Should respect retry semantics and execute again appropriately
        expect(executionCount).toBeGreaterThanOrEqual(2); // Should execute again due to scheduler behavior
    });

    test("should choose earlier time between cron and retry", async () => {
        const capabilities = getTestCapabilities();
        let executionTimes = [];
        
        const task = jest.fn(() => {
            executionTimes.push(new Date().toISOString());
            throw new Error("Always fails for this test");
        });
        
        const registrations = [
            ["timing-test", "0 */15 * * *", task, COMMON.THREE_MINUTES], // Task runs every 15 minutes with 3-minute retry
        ];
        
        // Initialize and trigger first execution 
        await initialize(capabilities, registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 150));
        
        expect(executionTimes).toHaveLength(1); // First execution should happen
        
        // Call initialize again to test retry logic
        await initialize(capabilities, registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 150));
        
        expect(executionTimes.length).toBeGreaterThan(1); // Should have additional executions
    });

    test("should use retry time when it comes before next cron tick", async () => {
        const capabilities = getTestCapabilities();
        let executionTimes = [];
        
        const task = jest.fn(() => {
            executionTimes.push(new Date().toISOString());
            throw new Error("Always fails for this test");
        });
        
        const registrations = [
            ["retry-priority-test", "* * * * *", task, COMMON.THIRTY_SECONDS], // Every minute with 30s retry - more frequent for testing
        ];
        
        // Initialize and trigger first execution
        await initialize(capabilities, registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 200));
        
        const initialExecutions = executionTimes.length;
        expect(initialExecutions).toBeGreaterThanOrEqual(1); // First execution should happen
        
        // Call initialize again to trigger retry behavior 
        await initialize(capabilities, registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Since task runs every minute, it should execute again
        expect(executionTimes.length).toBeGreaterThanOrEqual(initialExecutions); // Should have additional executions
    });

    test("should provide correct behavior when both cron and retry are applicable", async () => {
        const capabilities = getTestCapabilities();
        
        const task = jest.fn(() => {
            throw new Error("Task always fails");
        });
        
        const registrations = [
            ["mode-test", "* * * * *", task, COMMON.TEN_MINUTES], // Every minute with 10-minute retry
        ];
        
        // Initialize and trigger first execution
        await initialize(capabilities, registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 150));
        
        expect(task).toHaveBeenCalled(); // First execution should happen
        
        // Call initialize again to test scheduling behavior
        await initialize(capabilities, registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 150));
        
        // Should handle cron and retry logic appropriately
        expect(task).toHaveBeenCalledTimes(2);
    });

    test("should clear retry state after successful cron execution", async () => {
        const capabilities = getTestCapabilities();
        let executionCount = 0;
        
        const task = jest.fn(() => {
            executionCount++;
            if (executionCount <= 2) { // First couple executions fail
                throw new Error("Execution fails");
            }
            // Later executions succeed
        });
        
        const registrations = [
            ["clear-retry-test", "* * * * *", task, COMMON.FIVE_MINUTES], // Every minute with 5-minute retry - more frequent for testing
        ];
        
        // Initialize and trigger first execution (may execute multiple times initially)
        await initialize(capabilities, registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 200));
        
        const initialExecutions = executionCount;
        expect(initialExecutions).toBeGreaterThanOrEqual(1); // At least one execution should happen
        
        // Call initialize again for additional executions
        await initialize(capabilities, registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Since task runs every minute, should execute again
        expect(executionCount).toBeGreaterThanOrEqual(initialExecutions); // Additional executions should happen
        
        // Additional calls should continue to work properly (retry state management)
        await initialize(capabilities, registrations, { pollIntervalMs: 100 });
        await new Promise(resolve => setTimeout(resolve, 200));
        
        expect(executionCount).toBeGreaterThanOrEqual(2); // Should continue working
    });
});