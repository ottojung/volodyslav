const { validate, ScheduleInvalidNameError } = require("../src/cron");
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
        
        try {
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
        } finally {
            // Ensure cleanup even if test throws
            await capabilities1.scheduler.stop();
            await capabilities2.scheduler.stop();
        }
    });

});
