/**
 * Tests for schedule tasks functionality.
 */

const { everyHour, daily, allTasks, scheduleAll } = require("../src/schedule/tasks");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger,
    stubEnvironment,
    stubAiTranscriber,
    stubNotifier,
    stubScheduler,
} = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubAiTranscriber(capabilities);
    stubNotifier(capabilities);
    stubScheduler(capabilities);
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
        });

        test("completes without throwing errors", async () => {
            const capabilities = getTestCapabilities();

            await expect(everyHour(capabilities)).resolves.toBeUndefined();
        });
    });

    describe("allTasks", () => {
        test("completes without throwing errors", async () => {
            const capabilities = getTestCapabilities();

            await expect(allTasks(capabilities)).resolves.toBeUndefined();
        });
    });

    describe("scheduleAll", () => {
        test("schedules both hourly and daily tasks", () => {
            const capabilities = getTestCapabilities();

            scheduleAll(capabilities);

            expect(capabilities.scheduler.schedule).toHaveBeenCalledTimes(2);
            expect(capabilities.scheduler.schedule).toHaveBeenCalledWith("0 * * * *", expect.any(Function));
            expect(capabilities.scheduler.schedule).toHaveBeenCalledWith("0 2 * * *", expect.any(Function));
        });
    });
});
