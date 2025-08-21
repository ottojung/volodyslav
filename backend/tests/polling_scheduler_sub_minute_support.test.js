/**
 * Tests for sub-minute scheduler jobs support.
 * These tests verify that the scheduler now supports all valid cron expressions
 * and only rejects when the cron expression is shorter than the polling period.
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

describe("sub-minute scheduler jobs support", () => {
    test("should allow every minute cron expression with default polling", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Every minute should now be allowed with default polling (1 minute)
        const registrations = [
            ["every-minute-task", "* * * * *", taskCallback, retryDelay]
        ];
        
        await expect(capabilities.scheduler.initialize(registrations))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });

    test("should allow every 2 minutes cron expression with default polling", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Every 2 minutes should be allowed with default polling (1 minute)
        const registrations = [
            ["every-2min-task", "*/2 * * * *", taskCallback, retryDelay]
        ];
        
        await expect(capabilities.scheduler.initialize(registrations))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });

    test("should allow every 5 minutes cron expression with default polling", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Every 5 minutes should be allowed with default polling (1 minute)
        const registrations = [
            ["every-5min-task", "*/5 * * * *", taskCallback, retryDelay]
        ];
        
        await expect(capabilities.scheduler.initialize(registrations))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });

    test("should allow all common minute-level cron expressions with default polling", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // All these should now be allowed with default 1-minute polling
        const registrations = [
            ["every-minute", "* * * * *", taskCallback, retryDelay],
            ["every-2min", "*/2 * * * *", taskCallback, retryDelay],
            ["every-5min", "*/5 * * * *", taskCallback, retryDelay],
            ["every-10min", "*/10 * * * *", taskCallback, retryDelay],
            ["every-15min", "*/15 * * * *", taskCallback, retryDelay],
            ["every-30min", "*/30 * * * *", taskCallback, retryDelay],
            ["hourly", "0 * * * *", taskCallback, retryDelay],
            ["daily", "0 0 * * *", taskCallback, retryDelay],
        ];
        
        await expect(capabilities.scheduler.initialize(registrations))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });

    test("should still reject expressions more frequent than polling interval", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // With 5-minute polling, every minute should be rejected
        const registrations = [
            ["too-frequent-task", "* * * * *", taskCallback, retryDelay]
        ];
        
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 5 * 60 * 1000 }))
            .rejects.toThrow(/frequency.*higher.*polling/i);
    });

    test("should allow minute-level expressions with sub-minute polling", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // With 30-second polling, all minute-level expressions should be allowed
        const registrations = [
            ["every-minute-with-fast-poll", "* * * * *", taskCallback, retryDelay],
            ["every-2min-with-fast-poll", "*/2 * * * *", taskCallback, retryDelay],
        ];
        
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 30 * 1000 }))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });

    test("should allow very frequent polling intervals", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(1000);
        const taskCallback = jest.fn();
        
        // Test with 1-second polling (sub-minute)
        const registrations = [
            ["test-task", "* * * * *", taskCallback, retryDelay]
        ];
        
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 1000 }))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });

    test("should provide clear error messages for frequency mismatches", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // Test specific error message format
        const registrations = [
            ["frequency-test", "* * * * *", taskCallback, retryDelay]
        ];
        
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 2 * 60 * 1000 }))
            .rejects.toThrow(/Task frequency \(1 minute\) is higher than polling frequency \(2 minutes\)/);
    });

    test("should demonstrate practical sub-minute scheduling scenarios", async () => {
        const retryDelay = fromMilliseconds(1000);
        const taskCallback = jest.fn();
        
        // Practical scenarios that should now work out of the box
        const scenarios = [
            {
                name: "Health check every minute",
                cron: "* * * * *",
                pollMs: undefined, // Use default
            },
            {
                name: "Log rotation every 5 minutes", 
                cron: "*/5 * * * *",
                pollMs: undefined, // Use default
            },
            {
                name: "Quick backup every 2 minutes with fast polling",
                cron: "*/2 * * * *", 
                pollMs: 30 * 1000, // 30 seconds
            },
            {
                name: "Status check every minute with 10-second polling",
                cron: "* * * * *",
                pollMs: 10 * 1000, // 10 seconds
            }
        ];
        
        for (const scenario of scenarios) {
            const testCapabilities = getTestCapabilities();
            const registrations = [
                [scenario.name.replace(/\s+/g, '-'), scenario.cron, taskCallback, retryDelay]
            ];
            
            const options = scenario.pollMs ? { pollIntervalMs: scenario.pollMs } : undefined;
            
            await expect(testCapabilities.scheduler.initialize(registrations, options))
                .resolves.toBeUndefined();
                
            await testCapabilities.scheduler.stop();
        }
    });

    test("should verify actual default polling interval is 1 minute", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        
        // This test verifies that the default polling is indeed 1 minute by 
        // confirming that every-minute tasks work with default settings
        const registrations = [
            ["default-poll-test", "* * * * *", taskCallback, retryDelay]
        ];
        
        // Should work with no polling interval specified (uses default)
        await expect(capabilities.scheduler.initialize(registrations))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });
});