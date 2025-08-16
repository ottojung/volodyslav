const { make } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");

function caps() {
    return {
        logger: {
            logInfo: jest.fn(),
            logDebug: jest.fn(),
            logWarning: jest.fn(),
            logError: jest.fn(),
        },
    };
}

describe("polling scheduler skip running", () => {
    test("does not run while task is running", async () => {
        jest.useFakeTimers();
        const cron = make(caps(), { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(0);
        let resolve;
        const cb = jest.fn(() => new Promise(r => { resolve = r; }));
        await cron.schedule("t", "* * * * *", cb, retryDelay);

        jest.advanceTimersByTime(10);
        jest.advanceTimersByTime(10);
        expect(cb).toHaveBeenCalledTimes(1);

        resolve();
        await Promise.resolve();
        await cron.cancelAll();
    });
});

