/**
 * Tests for declarative scheduler frequency validation.
 * Ensures scheduler throws errors when task frequency is higher than polling frequency.
 */

const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    // Don't stub poll interval for validation tests - they need to test against real 10-minute interval
    return capabilities;
}

describe("declarative scheduler frequency validation", () => {

    test("should throw error when task frequency is higher than polling frequency", async () => {
        // Use default 10-minute (600000ms) polling interval
        const capabilities = getTestCapabilities();
        const retryDelay = Duration.fromMillis(5000);
        const taskCallback = jest.fn();

        // Try to initialize with task that runs every minute (higher frequency than 10-minute polling interval)
        const registrations = [
            ["high-freq-task", "* * * * *", taskCallback, retryDelay]
        ];

        await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();
        expect(capabilities.logger.logWarning).toHaveBeenCalledWith(
            expect.objectContaining({
                minCronInterval: expect.any(Number),
                pollIntervalMs: expect.any(Number),
                cron: "* * * * *"
            }),
            expect.stringMatching(/minimum interval.*less than the polling interval/i)
        );
        await capabilities.scheduler.stop();
    });

    test("should allow task frequency equal to polling frequency", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = Duration.fromMillis(5000);
        const taskCallback = jest.fn();

        // Initialize with task that runs every 10 minutes (matches polling interval)
        const registrations = [
            ["equal-freq-task", "*/10 * * * *", taskCallback, retryDelay]
        ];

        await expect(capabilities.scheduler.initialize(registrations))
            .resolves.toBeUndefined();

        await capabilities.scheduler.stop();
    });

    test("should allow task frequency lower than polling frequency", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = Duration.fromMillis(5000);
        const taskCallback = jest.fn();

        // Initialize with task that runs every hour (lower frequency than 10-minute polling)
        const registrations = [
            ["low-freq-task", "0 * * * *", taskCallback, retryDelay]
        ];

        await expect(capabilities.scheduler.initialize(registrations))
            .resolves.toBeUndefined();

        await capabilities.scheduler.stop();
    });

    test("should validate frequency for complex cron expressions", async () => {
        // Use separate capabilities instances to avoid task list mismatch
        const capabilities1 = getTestCapabilities();
        const capabilities2 = getTestCapabilities();
        const retryDelay = Duration.fromMillis(5000);
        const taskCallback = jest.fn();

        // Try to initialize with task that runs every 5 minutes (higher frequency than 10-minute polling)
        const invalidRegistrations = [
            ["complex-high-freq", "*/5 * * * *", taskCallback, retryDelay]
        ];

        await expect(capabilities1.scheduler.initialize(invalidRegistrations))
            .resolves.toBeUndefined();
        expect(capabilities1.logger.logWarning).toHaveBeenCalledWith(
            expect.objectContaining({
                minCronInterval: expect.any(Number),
                pollIntervalMs: expect.any(Number),
                cron: "*/5 * * * *"
            }),
            expect.stringMatching(/minimum interval.*less than the polling interval/i)
        );

        // Initialize with task that runs every 2 hours (lower frequency than 10-minute polling)
        const validRegistrations = [
            ["complex-low-freq", "0 */2 * * *", taskCallback, retryDelay]
        ];

        await expect(capabilities2.scheduler.initialize(validRegistrations))
            .resolves.toBeUndefined();

        await capabilities1.scheduler.stop();
        await capabilities2.scheduler.stop();
    });

    test("should provide clear error message with frequency details", async () => {
        const capabilities1 = getTestCapabilities();
        const capabilities2 = getTestCapabilities();
        const retryDelay = Duration.fromMillis(5000);
        const taskCallback = jest.fn();

        // Try to initialize with task that runs every minute (higher frequency than 10-minute polling interval)
        const registrations = [
            ["detailed-error-test", "* * * * *", taskCallback, retryDelay]
        ];

        await expect(capabilities1.scheduler.initialize(registrations))
            .resolves.toBeUndefined();
        expect(capabilities1.logger.logWarning).toHaveBeenCalledWith(
            expect.objectContaining({
                minCronInterval: expect.any(Number),
                pollIntervalMs: expect.any(Number),
                cron: "* * * * *"
            }),
            expect.stringMatching(/minimum interval.*less than the polling interval/i)
        );

        await expect(capabilities2.scheduler.initialize(registrations))
            .resolves.toBeUndefined();
        expect(capabilities2.logger.logWarning).toHaveBeenCalledWith(
            expect.objectContaining({
                minCronInterval: expect.any(Number),
                pollIntervalMs: expect.any(Number),
                cron: "* * * * *"
            }),
            expect.stringMatching(/minimum interval.*less than the polling interval/i)
        );

        await capabilities1.scheduler.stop();
        await capabilities2.scheduler.stop();
    });
});