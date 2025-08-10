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

describe("polling scheduler retry", () => {
    test("retries after delay and ignores cron", () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        const cron = make(caps(), { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(100);
        let count = 0;
        const cb = jest.fn(() => {
            count++;
            if (count === 1) {
                throw new Error("fail");
            }
        });
        cron.schedule("t", "* * * * *", cb, retryDelay);

        jest.advanceTimersByTime(10);
        expect(cb).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(90);
        expect(cb).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(20);
        expect(cb).toHaveBeenCalledTimes(2);

        cron.cancelAll();
    });
});

