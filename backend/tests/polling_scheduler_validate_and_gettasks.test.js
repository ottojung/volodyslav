const { validate, ScheduleInvalidNameError } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    return capabilities;
}

describe("declarative scheduler validation", () => {

    test("validate exposes parser and returns booleans", async () => {
        expect(validate("* * * * *")).toBe(true);
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
    });

});
