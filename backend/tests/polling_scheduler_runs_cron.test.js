const { make } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");

function createCapabilities() {
    return {
        logger: {
            logInfo: jest.fn(),
            logDebug: jest.fn(),
            logWarning: jest.fn(),
            logError: jest.fn(),
        },
    };
}

describe("polling scheduler runs cron", () => {
    test("executes once per minute", () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        const capabilities = createCapabilities();
        const cron = make(capabilities, { pollIntervalMs: 10 });
        const cb = jest.fn();
        const retryDelay = fromMilliseconds(0);
        cron.schedule("t", "* * * * *", cb, retryDelay);

        jest.advanceTimersByTime(10);
        expect(cb).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(20);
        expect(cb).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(60000);
        expect(cb).toHaveBeenCalledTimes(2);

        cron.cancelAll();
    });
});

