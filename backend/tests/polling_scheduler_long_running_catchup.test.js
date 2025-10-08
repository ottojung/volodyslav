/**
 * Tests for declarative scheduler long-running execution behavior.
 * Ensures cron catch-up occurs immediately after lengthy runs complete.
 */

const { fromISOString, fromMilliseconds, fromHours } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    stubSleeper,
    getDatetimeControl,
    stubScheduler,
    getSchedulerControl,
    stubRuntimeStateStorage,
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

describe("declarative scheduler long-running execution catch-up", () => {
    test("schedules follow-up cron run immediately after long execution completes", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);

        schedulerControl.setPollingInterval(fromMilliseconds(100));
        const retryDelay = fromMilliseconds(5000);

        // Start away from the cron boundary to avoid immediate execution.
        const startTime = fromISOString("2021-01-01T00:05:00.000Z");
        timeControl.setDateTime(startTime);

        /** @type {import("../src/datetime").DateTime[]} */
        const callTimes = [];
        /** @type {(value: void) => void} */
        let resolveFirstRun = () => {};
        const firstRunCompleted = new Promise((resolve) => {
            resolveFirstRun = resolve;
        });

        const task = jest.fn(async () => {
            callTimes.push(timeControl.getCurrentDateTime());

            if (callTimes.length === 1) {
                // Extend the run so it outlasts the next cron pulse.
                timeControl.advanceByDuration(fromHours(1));
                await new Promise((resolve) => setTimeout(resolve, 10));
                resolveFirstRun();
            }
        });

        const registrations = [["long-runner", "0 * * * *", task, retryDelay]];

        await capabilities.scheduler.initialize(registrations);

        try {
            // Allow the scheduler to settle.
            await schedulerControl.waitForNextCycleEnd();
            expect(task).not.toHaveBeenCalled();

            // Move to the next cron boundary and let the scheduler trigger the first run.
            timeControl.advanceByDuration(fromHours(1));
            await schedulerControl.waitForNextCycleEnd();
            await firstRunCompleted;

            // Give the scheduler a few cycles to notice the pending cron execution.
            for (let i = 0; i < 5 && task.mock.calls.length < 2; i++) {
                await schedulerControl.waitForNextCycleEnd();
            }

            expect(task).toHaveBeenCalledTimes(2);

            const [firstStart, secondStart] = callTimes;
            expect(secondStart.diff(firstStart).toMillis()).toBe(fromHours(1).toMillis());
            expect(secondStart.toISOString()).toBe(timeControl.getCurrentDateTime().toISOString());
        } finally {
            await capabilities.scheduler.stop();
        }
    });
});
