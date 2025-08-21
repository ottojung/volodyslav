/**
 * Tests for declarative scheduler retry behavior.
 * Focuses on observable retry execution rather than internal state inspection.
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

describe("declarative scheduler retry behavior", () => {
    test("task with retry executes callback multiple times on failure", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(100); // Short delay for testing
        let callCount = 0;
        const taskCallback = jest.fn(() => {
            callCount++;
            if (callCount <= 2) {
                throw new Error("simulated failure");
            }
            // Success on 3rd try
        });
        
        const registrations = [
            ["retry-task", "* * * * *", taskCallback, retryDelay]
        ];
        
        // Initialize with fast polling to observe retry behavior
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 50 });
        
        // Wait for initial execution and retries
        await new Promise(resolve => setTimeout(resolve, 400));
        
        // Should have been called multiple times due to retries
        expect(taskCallback).toHaveBeenCalledTimes(3);
        
        await capabilities.scheduler.stop();
        jest.useRealTimers();
    });

    test("successful task execution does not trigger retries", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(100);
        const taskCallback = jest.fn(); // Always succeeds
        
        const registrations = [
            ["success-task", "* * * * *", taskCallback, retryDelay]
        ];
        
        await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 50 });
        
        // Wait for one execution cycle
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Should have been called once on schedule, but no retries
        expect(taskCallback).toHaveBeenCalledTimes(1);
        
        await capabilities.scheduler.stop();
        jest.useRealTimers();
    });
});

