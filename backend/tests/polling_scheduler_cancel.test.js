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

describe("polling scheduler cancel", () => {
    test("cancel and cancelAll remove tasks", () => {
        jest.useFakeTimers();
        const cron = make(caps(), { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(0);
        cron.schedule("a", "* * * * *", () => {}, retryDelay);
        cron.schedule("b", "* * * * *", () => {}, retryDelay);
        expect(cron.getTasks().length).toBe(2);
        expect(cron.cancel("a")).toBe(true);
        expect(cron.getTasks().length).toBe(1);
        cron.schedule("c", "* * * * *", () => {}, retryDelay);
        expect(cron.cancelAll()).toBe(2);
        expect(cron.getTasks().length).toBe(0);
    });
});

