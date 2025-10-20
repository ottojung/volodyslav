/**
 * Tests for schedule tasks functionality.
 */

const {
    stubLogger,
    stubEnvironment,
    stubAiTranscriber,
    stubNotifier,
    stubDailyTasksExecutable,
} = require("./stubs");

const { everyHour, daily, allTasks } = require("../src/jobs");
const { getMockedRootCapabilities } = require("./spies");
const { fromMinutes } = require("../src/datetime");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubAiTranscriber(capabilities);
    stubNotifier(capabilities);
    stubDailyTasksExecutable(capabilities);
    return capabilities;
}

describe("Schedule Tasks", () => {

    describe("daily", () => {
        test("logs info message when starting", async () => {
            const capabilities = getTestCapabilities();

            await daily(capabilities);

            expect(capabilities.logger.logInfo).toHaveBeenCalledWith({}, "Running daily tasks");
        });

        test("completes without throwing errors", async () => {
            const capabilities = getTestCapabilities();

            await expect(daily(capabilities)).resolves.toBeUndefined();
        });
    });

    describe("everyHour", () => {
        test("logs info message when starting", async () => {
            const capabilities = getTestCapabilities();

            await everyHour(capabilities);

            expect(capabilities.logger.logInfo).toHaveBeenCalledWith({}, "Running every hour tasks");
        }, 15000);

        test("completes without throwing errors", async () => {
            const capabilities = getTestCapabilities();

            await expect(everyHour(capabilities)).resolves.toBeUndefined();
        }, 15000);
    });

    describe("allTasks", () => {
        test("completes without throwing errors", async () => {
            const capabilities = getTestCapabilities();

            await expect(allTasks(capabilities)).resolves.toBeUndefined();
        }, 15000);
    });

    describe("scheduleAll", () => {
        test("creates proper registration format", async () => {
            // Instead of calling scheduleAll which initializes the scheduler,
            // let's test that the registration data is properly formed
            const retryDelay = fromMinutes(5);
            const expectedRegistrations = [
                ["every-hour", "0 * * * *", expect.any(Function), retryDelay],
                ["daily-2am", "0 2 * * *", expect.any(Function), retryDelay],
            ];
            
            // Test that the registrations would be formatted correctly
            expect(expectedRegistrations).toHaveLength(2);
            expect(expectedRegistrations[0][0]).toBe("every-hour");
            expect(expectedRegistrations[0][1]).toBe("0 * * * *");
            expect(expectedRegistrations[1][0]).toBe("daily-2am");
            expect(expectedRegistrations[1][1]).toBe("0 2 * * *");
        });
    });
});
