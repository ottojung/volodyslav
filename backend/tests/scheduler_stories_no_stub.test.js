/**
 * Investigation test: Running scheduler stories WITHOUT stubRuntimeStateStorage
 * to understand what failures occur when runtime state stubbing is removed.
 */

const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubScheduler, getSchedulerControl } = require("./stubs");

function getTestCapabilitiesWithoutRuntimeStateStub() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    // NOTE: Deliberately NOT calling stubRuntimeStateStorage(capabilities)
    stubScheduler(capabilities);
    return capabilities;
}

describe("scheduler stories without runtime state stub", () => {
    test("should observe multiple task invocations by advancing time gradually - WITHOUT stub", async () => {
        const capabilities = getTestCapabilitiesWithoutRuntimeStateStub();
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

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start and possibly catch up
        await schedulerControl.waitForNextCycleEnd();

        // The scheduler may or may not catch up immediately - check current call count
        const initialCalls = taskCallback.mock.calls.length;

        // Now test that advancing time triggers new executions
        // Advance time to 00:30:00 (first execution after initialization)
        timeControl.advanceTime(25 * 60 * 1000); // 25 minutes to reach 00:30:00
        await schedulerControl.waitForNextCycleEnd();

        // Should have at least one more call than initial
        expect(taskCallback.mock.calls.length).toBeGreaterThan(initialCalls);

        const afterFirstAdvance = taskCallback.mock.calls.length;

        // Advance to 01:30:00
        timeControl.advanceTime(60 * 60 * 1000); // 1 hour
        await schedulerControl.waitForNextCycleEnd();
        expect(taskCallback.mock.calls.length).toBeGreaterThan(afterFirstAdvance);

        await capabilities.scheduler.stop();
    });

    test("should handle multiple tasks with different schedules - WITHOUT stub", async () => {
        const capabilities = getTestCapabilitiesWithoutRuntimeStateStub();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(5000);

        const hourlyTask = jest.fn();
        const dailyTask = jest.fn();

        // Set start time to 01:15:00 on Jan 1, 2021
        const startTime = new Date("2021-01-01T01:15:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["hourly-task", "0 * * * *", hourlyTask, retryDelay],   // Every hour at 0 minutes
            ["daily-task", "0 0 * * *", dailyTask, retryDelay],    // Every day at midnight (0:00)
        ];

        await capabilities.scheduler.initialize(registrations);

        // Wait for scheduler to start up.
        await schedulerControl.waitForNextCycleEnd();

        // Both tasks should start during the first cycle because they never ran before.
        expect(hourlyTask.mock.calls.length).toBeGreaterThan(0);
        expect(dailyTask.mock.calls.length).toBeGreaterThan(0);

        // Test that the scheduler is running and tasks are registered
        // This is mainly a smoke test to ensure the multiple task scheduling works

        await capabilities.scheduler.stop();
    });

    test("demonstrate issue: real state storage requires file system access", async () => {
        const capabilities = getTestCapabilitiesWithoutRuntimeStateStub();
        
        // Try to use the real state storage directly
        try {
            await capabilities.state.ensureAccessible();
            console.log("Real state storage accessible");
            
            // Try to perform a transaction
            await capabilities.state.transaction(async (storage) => {
                const currentState = await storage.getCurrentState();
                console.log("Current state:", currentState);
                
                // Try to set a new state
                const newState = { 
                    version: 2, 
                    startTime: capabilities.datetime.now(), 
                    tasks: [] 
                };
                storage.setState(newState);
                console.log("Set new state successfully");
            });
        } catch (error) {
            console.log("Error with real state storage:", error.message);
            throw error; // Make the test fail to see the issue
        }
    });

    test("investigate state property in mocked capabilities", async () => {
        const capabilities = getTestCapabilitiesWithoutRuntimeStateStub();
        
        console.log("State object:", typeof capabilities.state);
        console.log("State.transaction:", typeof capabilities.state.transaction);
        console.log("State.ensureAccessible:", typeof capabilities.state.ensureAccessible);
        console.log("Is transaction a mock?", jest.isMockFunction(capabilities.state.transaction));
        console.log("Is ensureAccessible a mock?", jest.isMockFunction(capabilities.state.ensureAccessible));
        
        // Let's see what happens when we call these methods
        try {
            await capabilities.state.ensureAccessible();
            console.log("ensureAccessible succeeded");
        } catch (error) {
            console.log("ensureAccessible failed:", error.message);
        }
        
        try {
            await capabilities.state.transaction(async (storage) => {
                console.log("In transaction, storage type:", typeof storage);
                console.log("Storage methods:", Object.keys(storage));
            });
        } catch (error) {
            console.log("Transaction failed:", error.message);
        }
    });
});