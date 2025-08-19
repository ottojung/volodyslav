/**
 * Tests for polling scheduler frequency validation.
 * Ensures scheduler throws errors when task frequency is higher than polling frequency.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function caps() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("polling scheduler frequency validation", () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test("should throw error when task frequency is higher than polling frequency", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Create scheduler with 10-minute polling interval
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 * 60 * 1000 });
        
        // Try to schedule task that runs every minute (higher frequency than polling)
        await expect(scheduler.schedule("high-freq-task", "* * * * *", taskCallback, retryDelay))
            .rejects.toThrow(/frequency.*higher.*polling/i);
            
        await scheduler.cancelAll();
    });

    test("should allow task frequency equal to polling frequency", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Create scheduler with 1-minute polling interval
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60 * 1000 });
        
        // Schedule task that runs every minute (same frequency as polling)
        await expect(scheduler.schedule("equal-freq-task", "* * * * *", taskCallback, retryDelay))
            .resolves.toBe("equal-freq-task");
            
        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);
        
        await scheduler.cancelAll();
    });

    test("should allow task frequency lower than polling frequency", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Create scheduler with 1-minute polling interval
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60 * 1000 });
        
        // Schedule task that runs every 5 minutes (lower frequency than polling)
        await expect(scheduler.schedule("low-freq-task", "*/5 * * * *", taskCallback, retryDelay))
            .resolves.toBe("low-freq-task");
            
        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);
        
        await scheduler.cancelAll();
    });

    test("should validate frequency for complex cron expressions", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Create scheduler with 1-hour polling interval
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60 * 60 * 1000 });
        
        // Try to schedule task that runs every 30 minutes (higher frequency)
        await expect(scheduler.schedule("complex-high-freq", "*/30 * * * *", taskCallback, retryDelay))
            .rejects.toThrow(/frequency.*higher.*polling/i);
            
        // Schedule task that runs every 2 hours (lower frequency)
        await expect(scheduler.schedule("complex-low-freq", "0 */2 * * *", taskCallback, retryDelay))
            .resolves.toBe("complex-low-freq");
            
        await scheduler.cancelAll();
    });

    test("should provide clear error message with frequency details", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Create scheduler with 5-minute polling interval
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 5 * 60 * 1000 });
        
        await expect(scheduler.schedule("detailed-error-test", "* * * * *", taskCallback, retryDelay))
            .rejects.toThrow(/task.*frequency.*1.*minute/i);
        
        await expect(scheduler.schedule("detailed-error-test", "* * * * *", taskCallback, retryDelay))
            .rejects.toThrow(/polling.*frequency.*5.*minute/i);
        
        await scheduler.cancelAll();
    });
});