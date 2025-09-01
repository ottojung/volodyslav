const { parseCronExpression } = require("../src/scheduler");
const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubScheduler } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubScheduler(capabilities);
    return capabilities;
}

/**
 * Validate a cron expression without creating a scheduler.
 * @param {string} cronExpression
 * @returns {boolean}
 */
function validate(cronExpression) {
    try {
        parseCronExpression(cronExpression);
        return true;
    } catch {
        return false;
    }
}

describe("declarative scheduler validation", () => {

    test("validate exposes parser and returns booleans", async () => {
        expect(validate("0 * * * *")).toBe(true);
        expect(validate("0 2 * * *")).toBe(true);
        expect(validate("60 * * * *")).toBe(false); // invalid minute
        expect(validate(/** @type string */(null))).toBe(false);
    });

    test("throws on invalid task name (empty/whitespace)", async () => {
        const capabilities1 = getTestCapabilities();
        const capabilities2 = getTestCapabilities();
        const retryDelay = Duration.fromMillis(0);

        // Try to initialize with invalid task names
        const emptyNameRegistrations = [
            ["", "0 * * * *", () => { }, retryDelay] // Every hour
        ];
        const whitespaceNameRegistrations = [
            ["   ", "0 * * * *", () => { }, retryDelay] // Every hour
        ];

        await expect(capabilities1.scheduler.initialize(emptyNameRegistrations))
            .rejects.toThrow(/must be a non-empty string/);
        await expect(capabilities2.scheduler.initialize(whitespaceNameRegistrations))
            .rejects.toThrow(/must be a non-empty string/);

        await capabilities1.scheduler.stop();
        await capabilities2.scheduler.stop();
    });
});
