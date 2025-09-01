/**
 * Minimal test to reproduce and debug the scheduler issue
 */

const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubRuntimeStateStorage, stubScheduler, getDatetimeControl, getSchedulerControl } = require("./stubs");

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

describe("minimal scheduler reproduce", () => {
    test("reproduce the bug with minimal setup", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(500);

        const task2h = jest.fn();
        const task4h = jest.fn();

        // Start at midnight
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["task-2h", "0 */2 * * *", task2h, retryDelay],
            ["task-4h", "0 */4 * * *", task4h, retryDelay],
        ];

        console.log("=== Initialize ===");
        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        console.log(`After init: 2h=${task2h.mock.calls.length}, 4h=${task4h.mock.calls.length}`);
        
        // Should both be 1
        expect(task2h.mock.calls.length).toBe(1);
        expect(task4h.mock.calls.length).toBe(1);

        // Advance to 02:00
        console.log("=== Advance to 02:00 ===");
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        console.log(`After 02:00: 2h=${task2h.mock.calls.length}, 4h=${task4h.mock.calls.length}`);
        
        // 2h task should execute again, 4h should not
        expect(task2h.mock.calls.length).toBe(2); // This should pass but currently fails
        expect(task4h.mock.calls.length).toBe(1);

        await capabilities.scheduler.stop();
    });
});