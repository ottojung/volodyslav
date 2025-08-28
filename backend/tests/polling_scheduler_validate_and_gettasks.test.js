const { parseCronExpression } = require("../src/scheduler");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubPollInterval } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubPollInterval(1); // Fast polling for tests
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
        expect(validate(/** @type any */(null))).toBe(false);
    });

    test("throws on invalid task name (empty/whitespace)", async () => {
        const capabilities1 = getTestCapabilities();
        const capabilities2 = getTestCapabilities();
        const retryDelay = fromMilliseconds(0);
        
        // Try to initialize with invalid task names
        const emptyNameRegistrations = [
            ["", "0 * * * *", () => {}, retryDelay] // Every hour
        ];
        const whitespaceNameRegistrations = [
            ["   ", "0 * * * *", () => {}, retryDelay] // Every hour
        ];
        
        await expect(capabilities1.scheduler.initialize(emptyNameRegistrations))
            .rejects.toThrow(ScheduleInvalidNameError);
        await expect(capabilities2.scheduler.initialize(whitespaceNameRegistrations))
            .rejects.toThrow(ScheduleInvalidNameError);
        
        await capabilities1.scheduler.stop();
        await capabilities2.scheduler.stop();
    });

});
