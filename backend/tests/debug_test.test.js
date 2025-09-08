const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubRuntimeStateStorage, stubScheduler, getSchedulerControl } = require("./stubs");
const { fromISOString, fromMinutes } = require("../src/datetime");

function getTestCapabilities() {
    const environment = stubEnvironment();
    const logger = stubLogger();
    const datetime = stubDatetime();
    const sleeper = stubSleeper();
    const state = stubRuntimeStateStorage();
    const scheduler = stubScheduler();

    return getMockedRootCapabilities(environment, logger, datetime, sleeper, state, scheduler);
}

test("debug task decision", async () => {
    console.log("Testing task decision logic...");
    
    const capabilities = getTestCapabilities();
    const dateControl = getDatetimeControl(capabilities);
    const schedulerControl = getSchedulerControl(capabilities);

    // Speed up scheduler polling for test
    schedulerControl.setPollingInterval(fromMinutes(1));
    dateControl.setDateTime(fromISOString("2021-01-01T00:00:00.000Z"));

    const callback1 = jest.fn();
    const callback2 = jest.fn();
    const callback3 = jest.fn();

    // Set up initial state
    const initialRegistrations = [
        ["task1", "0 0 * * *", callback1, Duration.fromObject({minutes: 5})],
        ["task2", "0 0 * * *", callback2, Duration.fromObject({minutes: 5})],
    ];

    console.log("Initializing scheduler with initial registrations...");
    await capabilities.scheduler.initialize(initialRegistrations);

    await schedulerControl.waitForNextCycleEnd();

    console.log("Initial execution completed");
    console.log(`callback1 calls: ${callback1.mock.calls.length}`);
    console.log(`callback2 calls: ${callback2.mock.calls.length}`);

    // Stop and restart with different registrations
    const mismatchedRegistrations = [
        ["task1", "0 0 * * *", callback1, Duration.fromObject({minutes: 5})],
        ["task3", "0 0 * * *", callback3, Duration.fromObject({minutes: 5})],
    ];

    console.log("Stopping scheduler...");
    await capabilities.scheduler.stop();
    dateControl.advanceByDuration(Duration.fromObject({ minutes: 10 }));

    console.log("Restarting scheduler with mismatched registrations...");
    await capabilities.scheduler.initialize(mismatchedRegistrations);

    console.log("After restart:");
    console.log(`callback1 calls: ${callback1.mock.calls.length}`);
    console.log(`callback2 calls: ${callback2.mock.calls.length}`);
    console.log(`callback3 calls: ${callback3.mock.calls.length}`);

    await schedulerControl.waitForNextCycleEnd();

    console.log("After first cycle:");
    console.log(`callback1 calls: ${callback1.mock.calls.length}`);
    console.log(`callback2 calls: ${callback2.mock.calls.length}`);
    console.log(`callback3 calls: ${callback3.mock.calls.length}`);

    await capabilities.scheduler.stop();
});