/**
 * Tests for declarative scheduler frequency validation.
 * Ensures scheduler throws errors when task frequency is higher than polling frequency.
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
    return capabilities;
}

describe("declarative scheduler frequency validation", () => {
    beforeEach(() => {
        jest.resetModules();
    });

    test("should throw error when task frequency is higher than polling frequency", async () => {
        // Use default 10-minute (600000ms) polling interval
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Try to initialize with task that runs every minute with 10-minute polling interval
        const registrations = [
            ["high-freq-task", "* * * * *", taskCallback, retryDelay]
        ];
        
        await expect(capabilities.scheduler.initialize(registrations))
            .rejects.toThrow(/frequency.*higher.*polling/i);
    });

    test("should allow task frequency equal to polling frequency", async () => {
        // Set polling interval to 1 minute for this test
        stubPollInterval(60 * 1000);
        
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Initialize with task that runs every minute with 1-minute polling interval
        const registrations = [
            ["equal-freq-task", "* * * * *", taskCallback, retryDelay]
        ];
        
        await expect(capabilities.scheduler.initialize(registrations))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });

    test("should allow task frequency lower than polling frequency", async () => {
        // Set polling interval to 1 minute for this test
        stubPollInterval(60 * 1000);
        
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Initialize with task that runs every 5 minutes with 1-minute polling interval
        const registrations = [
            ["low-freq-task", "*/5 * * * *", taskCallback, retryDelay]
        ];
        
        await expect(capabilities.scheduler.initialize(registrations))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });

    test("should validate frequency for complex cron expressions", async () => {
        // Set polling interval to 1 hour for this test
        stubPollInterval(60 * 60 * 1000);
        
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Try to initialize with task that runs every 30 minutes with 1-hour polling interval
        const invalidRegistrations = [
            ["complex-high-freq", "*/30 * * * *", taskCallback, retryDelay]
        ];
        
        await expect(capabilities.scheduler.initialize(invalidRegistrations))
            .rejects.toThrow(/frequency.*higher.*polling/i);
            
        // Initialize with task that runs every 2 hours (lower frequency)
        const validRegistrations = [
            ["complex-low-freq", "0 */2 * * *", taskCallback, retryDelay]
        ];
        
        await expect(capabilities.scheduler.initialize(validRegistrations))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });

    test("should provide clear error message with frequency details", async () => {
        // Set polling interval to 5 minutes for this test
        stubPollInterval(5 * 60 * 1000);
        
        const capabilities1 = getTestCapabilities();
        const capabilities2 = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Try to initialize with task that runs every minute with 5-minute polling interval
        const registrations = [
            ["detailed-error-test", "* * * * *", taskCallback, retryDelay]
        ];
        
        await expect(capabilities1.scheduler.initialize(registrations))
            .rejects.toThrow(/task.*frequency.*1.*minute/i);
        
        await expect(capabilities2.scheduler.initialize(registrations))
            .rejects.toThrow(/polling.*frequency.*5.*minute/i);
    });
});