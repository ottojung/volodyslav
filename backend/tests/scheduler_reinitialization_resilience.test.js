jest.mock("../src/scheduler/persistence", () => {
    const actual = jest.requireActual("../src/scheduler/persistence");
    return {
        ...actual,
        initializeTasks: jest.fn(actual.initializeTasks),
    };
});

const { fromMilliseconds, fromISOString } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    stubSleeper,
    stubRuntimeStateStorage,
    stubScheduler,
    getSchedulerControl,
    getDatetimeControl,
} = require("./stubs");
const persistence = require("../src/scheduler/persistence");

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

describe("scheduler reinitialization resilience", () => {
    test("reinitialization failure keeps original scheduler polling", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        const datetimeControl = getDatetimeControl(capabilities);

        schedulerControl.setPollingInterval(fromMilliseconds(10));

        const retryDelay = fromMilliseconds(5000);
        const taskCallback = jest.fn();
        const registrations = [["keep-alive-task", "* * * * *", taskCallback, retryDelay]];

        datetimeControl.setDateTime(fromISOString("2024-01-02T15:30:00.000Z"));

        try {
            await capabilities.scheduler.initialize(registrations);
            await schedulerControl.waitForNextCycleEnd();
            expect(taskCallback).toHaveBeenCalledTimes(1);

            taskCallback.mockClear();

            const forcedFailure = new Error("forced initializeTasks failure");
            persistence.initializeTasks.mockImplementationOnce(async () => {
                throw forcedFailure;
            });

            await expect(capabilities.scheduler.initialize(registrations)).rejects.toThrow(forcedFailure);

            datetimeControl.setDateTime(fromISOString("2024-01-02T15:31:00.000Z"));

            for (let attempt = 0; attempt < 5 && taskCallback.mock.calls.length === 0; attempt += 1) {
                await schedulerControl.waitForNextCycleEnd();
            }

            expect(taskCallback).toHaveBeenCalled();
        } finally {
            await capabilities.scheduler.stop();
        }
    });
});

