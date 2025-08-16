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
    test("throws on duplicate name", async () => {
        const cron = make(caps(), { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(0);
        await cron.schedule("a", "* * * * *", () => {}, retryDelay);
        await expect(cron.schedule("a", "* * * * *", () => {}, retryDelay)).rejects.toThrow(ScheduleDuplicateTaskError);
        await cron.cancelAll();
    });
});

