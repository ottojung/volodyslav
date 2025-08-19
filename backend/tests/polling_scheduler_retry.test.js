const { make } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper } = require("./stubs");

function caps() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    return capabilities;
}

describe("polling scheduler retry", () => {
    test("task with retry delay shows correct mode hints", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        const cron = make(caps(), { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(5000); // 5 second delay for clear testing
        let count = 0;
        const cb = jest.fn(() => {
            count++;
            if (count === 1) {
                throw new Error("fail");
            }
        });
        await cron.schedule("t", "* * * * *", cb, retryDelay);

        // Advance timers to trigger first execution
        jest.advanceTimersByTime(10);
        
        // Verify task failed and retry is scheduled
        let tasks = await cron.getTasks();
        expect(tasks).toHaveLength(1);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(tasks[0].pendingRetryUntil).toBeTruthy();
        expect(tasks[0].modeHint).toBe("idle"); // Retry not due yet

        // Advance time beyond retry delay
        jest.advanceTimersByTime(5000);
        
        // Verify retry is now due
        tasks = await cron.getTasks();
        expect(tasks[0].modeHint).toBe("retry"); // Should be due for retry

        await cron.cancelAll();
    });
});

