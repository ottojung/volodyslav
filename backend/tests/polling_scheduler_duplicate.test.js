const { make, ScheduleDuplicateTaskError } = require("../src/cron");
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

describe("polling scheduler duplicate", () => {
    test("throws on duplicate name", () => {
        const cron = make(caps(), { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(0);
        cron.schedule("a", "* * * * *", () => {}, retryDelay);
        expect(() =>
            cron.schedule("a", "* * * * *", () => {}, retryDelay)
        ).toThrow(ScheduleDuplicateTaskError);
        cron.cancelAll();
    });
});

