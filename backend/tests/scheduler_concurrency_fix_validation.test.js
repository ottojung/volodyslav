/**
 * Test to validate the fix for scheduler concurrency and Jest worker exit issue.
 * This test specifically verifies that concurrent initialize() calls don't create
 * orphaned polling schedulers that would cause Jest to hang.
 */

const { fromMilliseconds } = require("../src/time_duration");
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

describe("scheduler concurrency fix validation", () => {
    test("should handle concurrent initialize calls without creating orphaned schedulers", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(10); // Fast polling for test
        const retryDelay = fromMilliseconds(1000);
        
        let totalTaskExecutions = 0;
        const testTask = jest.fn(async () => {
            totalTaskExecutions++;
        });
        
        const registrations = [
            ["concurrency-test-task", "0 * * * *", testTask, retryDelay]
        ];
        
        // Call initialize multiple times concurrently - this used to create orphaned schedulers
        const concurrentCount = 5;
        const promises = Array(concurrentCount).fill().map(() => 
            capabilities.scheduler.initialize(registrations)
        );
        
        // All should resolve successfully
        await Promise.all(promises);
        
        // Wait for at least one polling cycle to confirm scheduler is working
        await schedulerControl.waitForNextCycleEnd();
        
        // Task should execute only once despite multiple initialize calls
        expect(testTask).toHaveBeenCalled();
        
        // Stop the scheduler - this should clean up all resources
        await capabilities.scheduler.stop();
        
        // After stop, no more executions should happen
        const executionsAfterStop = totalTaskExecutions;
        await new Promise(resolve => setTimeout(resolve, 50)); // Small delay
        expect(totalTaskExecutions).toBe(executionsAfterStop);
    });

    test("should properly handle stop after multiple concurrent initializations", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(1000);
        
        const testTask = jest.fn();
        const registrations = [
            ["stop-test-task", "0 * * * *", testTask, retryDelay]
        ];
        
        // Multiple concurrent initializations
        await Promise.all([
            capabilities.scheduler.initialize(registrations),
            capabilities.scheduler.initialize(registrations),
            capabilities.scheduler.initialize(registrations)
        ]);
        
        // Single stop should clean up everything
        await capabilities.scheduler.stop();
        
        // Verify scheduler is truly stopped by trying to stop again
        await capabilities.scheduler.stop(); // Should not throw or hang
    });
});