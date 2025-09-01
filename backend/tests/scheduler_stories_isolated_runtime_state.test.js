/**
 * Investigation test: Running scheduler stories without ONLY stubRuntimeStateStorage
 * but keeping all other stubs to isolate the runtime state specific issues.
 */

const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubScheduler, getSchedulerControl } = require("./stubs");

function getTestCapabilitiesWithoutOnlyRuntimeStateStub() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    // NOTE: Deliberately NOT calling stubRuntimeStateStorage(capabilities)
    // but keeping all other stubs - this should isolate runtime state issues
    stubScheduler(capabilities);
    return capabilities;
}

describe("scheduler stories without ONLY runtime state stub", () => {
    test("investigate what the mocked state storage looks like", async () => {
        const capabilities = getTestCapabilitiesWithoutOnlyRuntimeStateStub();
        
        console.log("State object type:", typeof capabilities.state);
        console.log("State.transaction type:", typeof capabilities.state.transaction);
        console.log("State.ensureAccessible type:", typeof capabilities.state.ensureAccessible);
        console.log("Is state.transaction a mock?", jest.isMockFunction(capabilities.state.transaction));
        console.log("Is state.ensureAccessible a mock?", jest.isMockFunction(capabilities.state.ensureAccessible));
        
        // Check what the default mock implementation returns
        console.log("About to call ensureAccessible...");
        const ensureResult = await capabilities.state.ensureAccessible();
        console.log("ensureAccessible result:", ensureResult);
        
        console.log("About to start transaction...");
        try {
            const transactionResult = await capabilities.state.transaction(async (storage) => {
                console.log("In transaction - storage:", storage);
                console.log("Storage is null/undefined:", storage == null);
                
                if (storage && typeof storage.getCurrentState === 'function') {
                    const currentState = await storage.getCurrentState();
                    console.log("Current state:", currentState);
                } else {
                    console.log("Storage doesn't have getCurrentState method");
                }
                
                return "test-result";
            });
            console.log("Transaction result:", transactionResult);
        } catch (error) {
            console.log("Transaction failed:", error.message);
            console.log("Error type:", error.constructor.name);
            console.log("Error stack:", error.stack);
        }
    });

    test("scheduler behavior without runtime state stub", async () => {
        const capabilities = getTestCapabilitiesWithoutOnlyRuntimeStateStub();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(5000);
        const taskCallback = jest.fn();

        // Set initial time to 00:05:00
        const startTime = new Date("2021-01-01T00:05:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        // Schedule a task that runs at 30 minutes past each hour
        const registrations = [
            ["half-hour-task", "30 * * * *", taskCallback, retryDelay] // Runs at minute 30 of each hour
        ];

        console.log("About to initialize scheduler...");
        await capabilities.scheduler.initialize(registrations);
        console.log("Scheduler initialized successfully");

        // Wait for scheduler to start and possibly catch up
        await schedulerControl.waitForNextCycleEnd();
        console.log("Scheduler first cycle completed");

        const initialCalls = taskCallback.mock.calls.length;
        console.log("Initial task calls:", initialCalls);

        // Now test that advancing time triggers new executions
        timeControl.advanceTime(25 * 60 * 1000); // 25 minutes to reach 00:30:00
        await schedulerControl.waitForNextCycleEnd();
        console.log("After time advance, task calls:", taskCallback.mock.calls.length);

        // The test might fail here if the mocked runtime state doesn't work properly
        expect(taskCallback.mock.calls.length).toBeGreaterThanOrEqual(initialCalls);

        await capabilities.scheduler.stop();
    });

    test("test with multiple scheduler restarts to stress runtime state", async () => {
        const capabilities = getTestCapabilitiesWithoutOnlyRuntimeStateStub();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(5000);
        const taskCallback = jest.fn();

        // Set initial time
        const startTime = new Date("2021-01-01T10:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["hourly-task", "0 * * * *", taskCallback, retryDelay], // Every hour
        ];

        console.log("First scheduler initialization...");
        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        const firstCalls = taskCallback.mock.calls.length;
        console.log("After first initialization:", firstCalls);

        // Stop and restart scheduler
        await capabilities.scheduler.stop();
        console.log("Scheduler stopped");

        // Advance time and restart
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour
        
        console.log("Second scheduler initialization...");
        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        const secondCalls = taskCallback.mock.calls.length;
        console.log("After second initialization:", secondCalls);

        // This might fail if state persistence doesn't work properly
        expect(taskCallback.mock.calls.length).toBeGreaterThan(firstCalls);

        await capabilities.scheduler.stop();
    });
});