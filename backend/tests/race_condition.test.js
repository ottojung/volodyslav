/**
 * Test to reliably expose the race condition in state persistence
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubPollInterval, stubRuntimeStateStorage } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubRuntimeStateStorage(capabilities);
    stubPollInterval(1);
    return capabilities;
}

describe("race condition exposure test", () => {
    test("exposes race condition with controlled timing", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(20000);

        // Create tasks that will expose the race condition
        let task1Called = false;
        let task2Called = false;
        let task3Called = false;
        
        const task1 = jest.fn(async () => {
            task1Called = true;
            // Add a small delay to increase chance of race condition
            await new Promise(resolve => setTimeout(resolve, 5));
        });
        
        const task2 = jest.fn(async () => {
            task2Called = true;
            await new Promise(resolve => setTimeout(resolve, 5));
        });
        
        const task3 = jest.fn(async () => {
            task3Called = true;
            await new Promise(resolve => setTimeout(resolve, 5));
        });

        const registrations = [
            ["race-task-1", "0 * * * *", task1, retryDelay],
            ["race-task-2", "0 * * * *", task2, retryDelay],
            ["race-task-3", "0 * * * *", task3, retryDelay]
        ];

        // Set time to trigger immediate execution
        const startTime = new Date("2024-01-01T15:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        await capabilities.scheduler.initialize(registrations);

        // Wait for tasks to complete
        await new Promise(resolve => setTimeout(resolve, 200));

        expect(task1Called).toBe(true);
        expect(task2Called).toBe(true);
        expect(task3Called).toBe(true);

        // Check persisted state
        const finalState = await capabilities.state.transaction(async (storage) => {
            return await storage.getCurrentState();
        });

        const tasksWithSuccess = finalState.tasks.filter(t => t.lastSuccessTime);
        const tasksWithAttempt = finalState.tasks.filter(t => t.lastAttemptTime);

        console.log(`Tasks executed: 3`);
        console.log(`Tasks with success time: ${tasksWithSuccess.length}`);
        console.log(`Tasks with attempt time: ${tasksWithAttempt.length}`);
        
        // The race condition manifests as some task states not being persisted
        // All 3 tasks should have their states persisted
        expect(tasksWithSuccess.length).toBe(3);
        expect(tasksWithAttempt.length).toBe(3);

        await capabilities.scheduler.stop();
    });
});