/**
 * Deep debug test to understand the scheduler polling cycle
 */

const { parseCronExpression } = require("../src/scheduler/expression");
const { getMostRecentExecution } = require("../src/scheduler/calculator");
const { stubDatetime, getDatetimeControl, stubEnvironment, stubLogger, stubSleeper, stubRuntimeStateStorage, stubScheduler, getSchedulerControl } = require("./stubs");
const { getMockedRootCapabilities } = require("./spies");
const { Duration } = require("luxon");

describe("scheduler deep debug", () => {
    test("debug polling cycle with logging", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubLogger(capabilities);
        stubDatetime(capabilities);
        stubSleeper(capabilities);
        stubRuntimeStateStorage(capabilities);
        stubScheduler(capabilities);
        
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(500);

        const every2HourTask = jest.fn();

        // Start at exactly midnight
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["every-2h", "0 */2 * * *", every2HourTask, retryDelay],
        ];

        console.log("=== Initializing scheduler ===");
        await capabilities.scheduler.initialize(registrations);
        
        // Let's manually examine the task state
        console.log("=== Initial polling ===");
        await schedulerControl.waitForNextCycleEnd();

        const initial2Hour = every2HourTask.mock.calls.length;
        console.log("Initial 2-hour task calls:", initial2Hour);

        // Advance to 02:00:00 and examine state carefully
        console.log("=== Advancing to 02:00:00 ===");
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        
        // Let's trigger multiple polling cycles to see what happens
        console.log("=== First polling cycle at 02:00:00 ===");
        await schedulerControl.waitForNextCycleEnd();
        console.log("After first cycle - 2-hour task calls:", every2HourTask.mock.calls.length);
        
        console.log("=== Second polling cycle at 02:00:00 ===");
        await schedulerControl.waitForNextCycleEnd();
        console.log("After second cycle - 2-hour task calls:", every2HourTask.mock.calls.length);
        
        console.log("=== Third polling cycle at 02:00:00 ===");
        await schedulerControl.waitForNextCycleEnd();
        console.log("After third cycle - 2-hour task calls:", every2HourTask.mock.calls.length);

        await capabilities.scheduler.stop();
    });

    test("debug polling cycle with multiple tasks", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubLogger(capabilities);
        stubDatetime(capabilities);
        stubSleeper(capabilities);
        stubRuntimeStateStorage(capabilities);
        stubScheduler(capabilities);
        
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(500);

        const every2HourTask = jest.fn();
        const every4HourTask = jest.fn();

        // Start at exactly midnight
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["every-2h", "0 */2 * * *", every2HourTask, retryDelay],
            ["every-4h", "0 */4 * * *", every4HourTask, retryDelay],
        ];

        console.log("=== Initializing scheduler with multiple tasks ===");
        await capabilities.scheduler.initialize(registrations);
        
        console.log("=== Initial polling ===");
        await schedulerControl.waitForNextCycleEnd();

        const initial2Hour = every2HourTask.mock.calls.length;
        const initial4Hour = every4HourTask.mock.calls.length;
        console.log("Initial 2-hour task calls:", initial2Hour);
        console.log("Initial 4-hour task calls:", initial4Hour);

        // Advance to 02:00:00
        console.log("=== Advancing to 02:00:00 ===");
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        
        console.log("=== First polling cycle at 02:00:00 ===");
        await schedulerControl.waitForNextCycleEnd();
        console.log("After first cycle - 2-hour task calls:", every2HourTask.mock.calls.length);
        console.log("After first cycle - 4-hour task calls:", every4HourTask.mock.calls.length);

        await capabilities.scheduler.stop();
    });
});