/**
 * Tests for declarative scheduler cron expression validation.
 * Focuses on validating cron expressions are properly accepted during initialization.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubScheduler, getSchedulerControl } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubScheduler(capabilities);
    return capabilities;
}

describe("declarative scheduler cron expression validation", () => {
    test("accepts valid cron expressions during initialization", async () => {
        const capabilities = getTestCapabilities();
        const taskCallback = jest.fn();
        const retryDelay = fromMilliseconds(0);
        
        // Test various valid cron expressions
        const registrations = [
            ["hourly-task", "0 * * * *", taskCallback, retryDelay],      // Every hour
            ["daily-task", "0 9 * * *", taskCallback, retryDelay],       // Daily at 9 AM
            ["weekly-task", "0 9 * * 1", taskCallback, retryDelay],      // Mondays at 9 AM
            ["monthly-task", "0 9 1 * *", taskCallback, retryDelay],     // 1st of month at 9 AM
            ["minute-task", "*/15 * * * *", taskCallback, retryDelay]     // Every 5 minutes
        ];
        
        // Should succeed with valid cron expressions
        await expect(capabilities.scheduler.initialize(registrations))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });

    test("validates cron expressions are compatible with polling frequency", async () => {
        const capabilities = getTestCapabilities();
        const taskCallback = jest.fn();
        const retryDelay = fromMilliseconds(0);
        
        // Task that runs every hour - should be compatible with 1-minute polling
        const validRegistrations = [
            ["compatible-task", "0 * * * *", taskCallback, retryDelay]
        ];
        
        await expect(capabilities.scheduler.initialize(validRegistrations))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });
});

