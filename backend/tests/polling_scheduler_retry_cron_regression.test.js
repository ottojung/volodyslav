const { fromISOString, fromMinutes, fromMilliseconds } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    stubSleeper,
    stubScheduler,
    stubRuntimeStateStorage,
    getSchedulerControl,
    getDatetimeControl,
} = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubRuntimeStateStorage(capabilities);
    stubScheduler(capabilities);
    return capabilities;
}

describe("polling scheduler retry regression", () => {
    test("cron should trigger retrying task before pending retry deadline", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        schedulerControl.setPollingInterval(fromMilliseconds(50));
        const timeControl = getDatetimeControl(capabilities);

        const retryDelay = fromMinutes(10);
        let executions = 0;

        const task = jest.fn(() => {
            executions++;
            if (executions === 1) {
                throw new Error("first attempt fails");
            }
        });

        const registrations = [[
            "retry-cron-regression",
            "0,5,10,15,20,25,30,35,40,45,50,55 * * * *",
            task,
            retryDelay,
        ]];

        timeControl.setDateTime(fromISOString("2024-01-01T00:04:30Z"));

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Align to the next scheduled 5-minute mark so the task executes and fails once.
        timeControl.advanceByDuration(fromMilliseconds(30 * 1000));
        await schedulerControl.waitForNextCycleEnd();

        expect(task).toHaveBeenCalledTimes(1);

        // The retry delay is 10 minutes, but the cron tick in five minutes should trigger execution.
        timeControl.advanceByDuration(fromMinutes(5));
        await schedulerControl.waitForNextCycleEnd();

        expect(task).toHaveBeenCalledTimes(2);

        await capabilities.scheduler.stop();
    });
});
