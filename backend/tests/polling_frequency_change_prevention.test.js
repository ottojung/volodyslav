/**
 * Tests for polling frequency change prevention.
 * Ensures that attempting to change the polling frequency after initialization throws an error.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper } = require("./stubs");
const { isPollingFrequencyChangeError } = require("../src/schedule/errors");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    return capabilities;
}

describe("polling frequency change prevention", () => {
    test("should throw error when trying to change polling frequency", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        const registrations = [
            ["test-task", "0 * * * *", taskCallback, retryDelay] // Every hour
        ];
        
        // Initialize with first polling interval
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 60 * 1000 }))
            .resolves.toBeUndefined();
        
        // Attempt to change polling interval should throw error
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 120 * 1000 }))
            .rejects.toThrow(/Cannot change polling frequency/);
        
        // Verify the error is the specific type we expect
        let caughtError;
        try {
            await capabilities.scheduler.initialize(registrations, { pollIntervalMs: 120 * 1000 });
        } catch (error) {
            caughtError = error;
        }
        
        expect(caughtError).toBeDefined();
        expect(isPollingFrequencyChangeError(caughtError)).toBe(true);
        expect(caughtError.currentInterval).toBe(60 * 1000);
        expect(caughtError.requestedInterval).toBe(120 * 1000);
        
        await capabilities.scheduler.stop();
    });

    test("should allow multiple initializations with same polling frequency", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        const registrations = [
            ["test-task", "0 * * * *", taskCallback, retryDelay] // Every hour
        ];
        
        // Initialize with polling interval
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 60 * 1000 }))
            .resolves.toBeUndefined();
        
        // Re-initialize with same polling interval should work (idempotent)
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 60 * 1000 }))
            .resolves.toBeUndefined();
        
        // Initialize again without explicit pollIntervalMs (should use existing)
        await expect(capabilities.scheduler.initialize(registrations, {}))
            .resolves.toBeUndefined();
        
        await capabilities.scheduler.stop();
    });

    test("should allow initialization without pollIntervalMs after explicit interval", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        const registrations = [
            ["test-task", "0 * * * *", taskCallback, retryDelay] // Every hour
        ];
        
        // Initialize with explicit polling interval
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 60 * 1000 }))
            .resolves.toBeUndefined();
        
        // Re-initialize without pollIntervalMs should work (uses existing)
        await expect(capabilities.scheduler.initialize(registrations))
            .resolves.toBeUndefined();
        
        await capabilities.scheduler.stop();
    });

    test("should throw error when trying to change from default to explicit interval", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        const registrations = [
            ["test-task", "0 * * * *", taskCallback, retryDelay] // Every hour
        ];
        
        // Initialize with default polling interval (no explicit interval)
        await expect(capabilities.scheduler.initialize(registrations))
            .resolves.toBeUndefined();
        
        // Attempt to change to explicit interval should throw error
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 120 * 1000 }))
            .rejects.toThrow(/Cannot change polling frequency/);
        
        await capabilities.scheduler.stop();
    });
});