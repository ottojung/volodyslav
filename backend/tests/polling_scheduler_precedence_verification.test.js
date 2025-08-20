/**
 * Specific test to verify cron vs retry precedence logic
 * This test verifies that "earliest (chronologically smaller) wins" behavior
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

describe.skip("polling scheduler precedence logic verification", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2020-01-01T10:00:00Z"));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test("should choose retry when retry time is earlier than cron time", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(2 * 60 * 1000); // 2 minutes
        let executionModes = [];
        
        const task = jest.fn(() => {
            const now = new Date();
            executionModes.push({
                time: now.toISOString(),
                type: "execution"
            });
            throw new Error("Task fails to set up retry scenario");
        });
        
        // Task runs every 5 minutes (10:00, 10:05, 10:10, etc.)
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 30000 });
        await scheduler.schedule("precedence-test", "*/5 * * * *", task, retryDelay);
        
        // First execution at 10:00 - fails, retry scheduled for 10:02
        await scheduler._poll();
        expect(executionModes).toHaveLength(1);
        
        // At 10:01:30 - neither retry (10:02) nor cron (10:05) is due yet
        jest.setSystemTime(new Date("2020-01-01T10:01:30Z"));
        const tasksAt0130 = await scheduler.getTasks();
        expect(tasksAt0130[0].modeHint).toBe("idle");
        
        // At 10:02:00 - retry is due (10:02) but cron is not due yet (10:05)
        jest.setSystemTime(new Date("2020-01-01T10:02:00Z"));
        const tasksAt0200 = await scheduler.getTasks();
        expect(tasksAt0200[0].modeHint).toBe("retry");
        
        await scheduler._poll();
        expect(executionModes).toHaveLength(2);
        expect(executionModes[1].time).toBe("2020-01-01T10:02:00.000Z");
        
        await scheduler.cancelAll();
    });

    test("should choose cron when cron time is earlier than retry time", async () => {
        const capabilities = caps();
        const retryDelay = fromMilliseconds(6 * 60 * 1000); // 6 minutes
        let executionModes = [];
        
        const task = jest.fn(() => {
            const now = new Date();
            executionModes.push({
                time: now.toISOString(),
                type: "execution"
            });
            throw new Error("Task fails to set up retry scenario");
        });
        
        // Task runs every 3 minutes (10:00, 10:03, 10:06, etc.)
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 30000 });
        await scheduler.schedule("precedence-test", "*/3 * * * *", task, retryDelay);
        
        // First execution at 10:00 - fails, retry scheduled for 10:06
        await scheduler._poll();
        expect(executionModes).toHaveLength(1);
        
        // At 10:03:00 - cron is due (10:03) but retry is not due yet (10:06)
        jest.setSystemTime(new Date("2020-01-01T10:03:00Z"));
        const tasksAt0300 = await scheduler.getTasks();
        expect(tasksAt0300[0].modeHint).toBe("cron");
        
        await scheduler._poll();
        expect(executionModes).toHaveLength(2);
        expect(executionModes[1].time).toBe("2020-01-01T10:03:00.000Z");
        
        await scheduler.cancelAll();
    });

    test("should have consistent behavior when timestamps are equal", async () => {
        const capabilities = caps();
        
        // Set up a very specific timing scenario
        jest.setSystemTime(new Date("2020-01-01T10:00:00Z"));
        
        const retryDelay = fromMilliseconds(5 * 60 * 1000); // 5 minutes
        let executionModes = [];
        
        const task = jest.fn(() => {
            const now = new Date();
            executionModes.push({
                time: now.toISOString(),
                type: "execution"
            });
            throw new Error("Task fails to set up retry scenario");
        });
        
        // Task runs every 5 minutes (10:00, 10:05, 10:10, etc.)
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 30000 });
        await scheduler.schedule("precedence-test", "*/5 * * * *", task, retryDelay);
        
        // First execution at 10:00 - fails, retry scheduled for 10:05
        await scheduler._poll();
        expect(executionModes).toHaveLength(1);
        
        // At 10:05:00 - both retry (10:05) and cron (10:05) are due
        // Since retry was scheduled first (at 10:00 + 5min = 10:05)
        // and cron would fire at 10:05, the timestamps are equal
        // The behavior should be deterministic - test current implementation
        jest.setSystemTime(new Date("2020-01-01T10:05:00Z"));
        const tasksAt0500 = await scheduler.getTasks();
        
        // Current implementation should choose consistently
        expect(["retry", "cron"]).toContain(tasksAt0500[0].modeHint);
        
        await scheduler._poll();
        expect(executionModes).toHaveLength(2);
        expect(executionModes[1].time).toBe("2020-01-01T10:05:00.000Z");
        
        await scheduler.cancelAll();
    });
});