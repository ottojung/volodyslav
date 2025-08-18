/**
 * Tests for polling scheduler behavior during Daylight Saving Time (DST) transitions.
 * These tests ensure the scheduler handles time changes correctly, including:
 * - Spring forward (missing hour)
 * - Fall back (duplicated hour)
 * - Tasks scheduled during transition times
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

describe("polling scheduler DST transitions", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        // Start before DST transition
        jest.setSystemTime(new Date("2024-03-10T01:30:00-05:00")); // EST, before spring forward
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test("should handle spring forward transition (missing hour)", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });

        // Schedule task for 2:30 AM - this time will be skipped during spring forward
        await scheduler.schedule("missing-hour-task", "30 2 * * *", callback, retryDelay);

        // Move to after spring forward (2 AM becomes 3 AM)
        jest.setSystemTime(new Date("2024-03-10T03:30:00-04:00")); // EDT, after spring forward

        const tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);
        expect(tasks[0].modeHint).toBe("cron");

        // Task should be marked as ready since we passed its scheduled time
        expect(tasks[0].shouldRun).toBe(true);

        await scheduler.cancelAll();
    });

    test("should handle fall back transition (duplicated hour)", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();

        // Start just before fall back transition
        jest.setSystemTime(new Date("2024-11-03T01:30:00-04:00")); // EDT

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });

        // Schedule task for 1:30 AM - this time will occur twice during fall back
        await scheduler.schedule("duplicated-hour-task", "30 1 * * *", callback, retryDelay);

        // First occurrence (still EDT)
        let tasks = await scheduler.getTasks();
        expect(tasks[0].shouldRun).toBe(true);

        // Simulate running the task
        jest.setSystemTime(new Date("2024-11-03T01:31:00-04:00"));
        await scheduler.poll();
        expect(callback).toHaveBeenCalledTimes(1);

        // Move to after fall back (2 AM becomes 1 AM again, now EST)
        jest.setSystemTime(new Date("2024-11-03T01:30:00-05:00")); // EST, duplicated time

        tasks = await scheduler.getTasks();
        // Task should not run again for the same logical occurrence
        expect(tasks[0].shouldRun).toBe(false);

        await scheduler.cancelAll();
    });

    test("should handle tasks scheduled exactly at DST transition times", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });

        // Schedule task for 2:00 AM on spring forward day (this hour disappears)
        await scheduler.schedule("transition-time-task", "0 2 10 3 *", callback, retryDelay);

        // Move past the transition
        jest.setSystemTime(new Date("2024-03-10T03:00:00-04:00")); // EDT

        const tasks = await scheduler.getTasks();
        expect(tasks[0].shouldRun).toBe(true); // Should run since we passed the intended time

        await scheduler.cancelAll();
    });

    test("should maintain correct scheduling across multiple DST transitions", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });

        // Schedule daily task for 3:00 AM
        await scheduler.schedule("daily-task", "0 3 * * *", callback, retryDelay);

        // Go through multiple DST transitions
        const testDates = [
            "2024-03-09T04:00:00-05:00", // Before spring forward
            "2024-03-11T04:00:00-04:00", // After spring forward
            "2024-11-02T04:00:00-04:00", // Before fall back
            "2024-11-04T04:00:00-05:00", // After fall back
        ];

        for (const dateStr of testDates) {
            jest.setSystemTime(new Date(dateStr));
            const tasks = await scheduler.getTasks();
            expect(tasks[0].shouldRun).toBe(true);

            // Simulate task execution
            await scheduler.poll();
        }

        // Should have run 4 times (once for each day, regardless of DST)
        expect(callback).toHaveBeenCalledTimes(4);

        await scheduler.cancelAll();
    });

    test("should handle timezone changes gracefully", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });

        // Schedule task in one timezone
        await scheduler.schedule("timezone-task", "0 12 * * *", callback, retryDelay);

        // Initial time in EST
        jest.setSystemTime(new Date("2024-01-15T13:00:00-05:00"));

        let tasks = await scheduler.getTasks();
        expect(tasks[0].shouldRun).toBe(true);

        // Simulate system timezone change (this is tricky to test, but we verify robustness)
        // The scheduler should continue working with UTC internally
        jest.setSystemTime(new Date("2024-01-15T18:00:00+00:00")); // Same time, different representation

        tasks = await scheduler.getTasks();
        // Should still function correctly
        expect(tasks).toHaveLength(1);

        await scheduler.cancelAll();
    });

    test("should handle edge case DST transitions for weekly/monthly tasks", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });

        // Schedule weekly task for Sunday 2 AM (will be affected by spring forward)
        await scheduler.schedule("weekly-dst-task", "0 2 * * 0", callback, retryDelay);

        // Set to Sunday during spring forward
        jest.setSystemTime(new Date("2024-03-10T03:30:00-04:00")); // Sunday after spring forward

        const tasks = await scheduler.getTasks();
        expect(tasks[0].shouldRun).toBe(true);

        // Verify previous fire calculation worked correctly despite missing hour
        expect(tasks[0].previousFire).toBeDefined();

        await scheduler.cancelAll();
    });

    test("should maintain accurate lastSuccessTime across DST transitions", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn().mockResolvedValue(undefined);

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });

        // Schedule task before DST transition
        await scheduler.schedule("success-time-task", "0 1 * * *", callback, retryDelay);

        // Run task before spring forward
        jest.setSystemTime(new Date("2024-03-10T01:30:00-05:00"));
        await scheduler.poll();

        let tasks = await scheduler.getTasks();
        const successTimeBeforeDST = tasks[0].lastSuccessTime;
        expect(successTimeBeforeDST).toBeDefined();

        // Move past DST transition and run again
        jest.setSystemTime(new Date("2024-03-11T01:30:00-04:00")); // Next day, after DST
        await scheduler.poll();

        tasks = await scheduler.getTasks();
        const successTimeAfterDST = tasks[0].lastSuccessTime;

        // Both times should be recorded accurately
        expect(successTimeAfterDST).toBeDefined();
        expect(successTimeAfterDST).not.toEqual(successTimeBeforeDST);

        // Time difference should be approximately 24 hours (accounting for DST)
        const timeDiff = successTimeAfterDST.getTime() - successTimeBeforeDST.getTime();
        expect(timeDiff).toBeGreaterThan(22 * 60 * 60 * 1000); // At least 22 hours
        expect(timeDiff).toBeLessThan(25 * 60 * 60 * 1000); // At most 25 hours

        await scheduler.cancelAll();
    });

    test("should handle DST in different timezones consistently", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn();

        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });

        // Schedule task for different timezone DST scenarios
        await scheduler.schedule("multi-tz-task", "0 2 * * *", callback, retryDelay);

        // Test European DST (different date than US)
        jest.setSystemTime(new Date("2024-03-31T03:00:00+02:00")); // CEST (European spring forward)

        let tasks = await scheduler.getTasks();
        expect(tasks[0].shouldRun).toBe(true);

        // Test that scheduler maintains consistency regardless of timezone representation
        jest.setSystemTime(new Date("2024-03-31T01:00:00+00:00")); // Same time in UTC

        tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);

        await scheduler.cancelAll();
    });
});
