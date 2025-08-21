/**
 * Tests for declarative scheduler retry configuration.
 * Focuses on retry delay validation and configuration rather than execution.
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

describe("declarative scheduler retry configuration", () => {
    test("accepts valid retry delay configurations", async () => {
        const capabilities = getTestCapabilities();
        const taskCallback = jest.fn();
        
        // Test various valid retry delays
        const registrations = [
            ["retry-task-1", "0 * * * *", taskCallback, fromMilliseconds(100)],
            ["retry-task-2", "0 * * * *", taskCallback, fromMilliseconds(5000)],
            ["retry-task-3", "0 * * * *", taskCallback, fromMilliseconds(60000)]
        ];
        
        // Should succeed with valid retry configurations
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 60000 }))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });

    test("handles zero retry delay configuration", async () => {
        const capabilities = getTestCapabilities();
        const taskCallback = jest.fn();
        
        const registrations = [
            ["no-retry-task", "0 * * * *", taskCallback, fromMilliseconds(0)]
        ];
        
        // Zero retry delay should be valid (immediate retry)
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 60000 }))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });
});

