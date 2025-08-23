/**
 * Test that demonstrates the scheduler non-atomicity issue by simulating
 * non-atomic state persistence behavior.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubPollInterval } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    // Use a mock state transaction that simulates non-atomic behavior
    stubNonAtomicStateStorage(capabilities);
    stubPollInterval(1); // Very fast polling for tests
    return capabilities;
}

/**
 * Mock state storage that simulates non-atomic behavior by introducing
 * race conditions in read-modify-write operations.
 */
function stubNonAtomicStateStorage(capabilities) {
    let globalState = null;
    let operationCount = 0;
    
    capabilities.state = {
        transaction: jest.fn().mockImplementation(async (transformation) => {
            // Simulate non-atomic behavior by allowing race conditions
            const currentOperationId = ++operationCount;
            
            // Mock storage object
            const mockStorage = {
                async getCurrentState() {
                    if (globalState === null) {
                        const defaultState = {
                            version: 2,
                            startTime: capabilities.datetime.now(),
                            tasks: []
                        };
                        return defaultState;
                    }
                    // Return a COPY of the current state (simulating read)
                    return JSON.parse(JSON.stringify(globalState));
                },
                
                async getExistingState() {
                    return globalState ? JSON.parse(JSON.stringify(globalState)) : null;
                },
                
                setState(newState) {
                    // Simulate the race condition: add a delay to allow other operations
                    // to interleave, then overwrite the global state
                    setTimeout(() => {
                        // This is the key race condition: if multiple operations are happening
                        // concurrently, the last one to complete will overwrite all previous state
                        if (Math.random() < 0.7) {  // 70% chance to simulate lost update
                            // Simulate lost update by reverting to a previous state
                            const partialState = {
                                ...newState,
                                tasks: newState.tasks.slice(0, Math.max(1, newState.tasks.length - 1))
                            };
                            globalState = JSON.parse(JSON.stringify(partialState));
                            capabilities.logger.logDebug(
                                { operationId: currentOperationId, lostTasks: newState.tasks.length - partialState.tasks.length },
                                "Simulated race condition: lost task updates"
                            );
                        } else {
                            globalState = JSON.parse(JSON.stringify(newState));
                        }
                        capabilities.logger.logDebug(
                            { operationId: currentOperationId, taskCount: globalState.tasks.length },
                            "Non-atomic state write completed"
                        );
                    }, Math.random() * 20); // Random delay 0-20ms to simulate race
                },
                
                getNewState() {
                    return null; // Not used in this mock
                }
            };
            
            return await transformation(mockStorage);
        }),
        ensureAccessible: jest.fn().mockResolvedValue(undefined),
    };
}

describe("scheduler non-atomicity demonstration", () => {
    test("demonstrates state loss due to non-atomic persistence operations", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(30000);

        // Track task executions
        let task1Completed = false;
        let task2Completed = false;
        let task3Completed = false;

        const task1 = jest.fn(async () => {
            task1Completed = true;
        });

        const task2 = jest.fn(async () => {
            task2Completed = true;
        });

        const task3 = jest.fn(async () => {
            task3Completed = true;
        });

        const registrations = [
            ["demo-task-1", "0 * * * *", task1, retryDelay],
            ["demo-task-2", "0 * * * *", task2, retryDelay],
            ["demo-task-3", "0 * * * *", task3, retryDelay]
        ];

        // Set time to trigger immediate execution
        const startTime = new Date("2024-01-01T10:00:00.000Z").getTime();
        timeControl.setTime(startTime);

        await capabilities.scheduler.initialize(registrations);

        // Wait for all tasks to complete
        await new Promise(resolve => setTimeout(resolve, 200));

        // Verify tasks executed
        expect(task1Completed).toBe(true);
        expect(task2Completed).toBe(true);
        expect(task3Completed).toBe(true);

        // Wait a bit more for all non-atomic state writes to complete
        await new Promise(resolve => setTimeout(resolve, 150));

        // Get final state
        const finalState = await capabilities.state.transaction(async (storage) => {
            return await storage.getCurrentState();
        });

        // Due to non-atomic behavior, the final state might not reflect all task executions
        // The race condition causes later writes to overwrite earlier ones
        capabilities.logger.logDebug(
            { taskCount: finalState.tasks.length, tasks: finalState.tasks.map(t => t.name) },
            "Final state after non-atomic operations"
        );

        // This test SHOULD fail to demonstrate the race condition!
        // In a correct implementation, all 3 tasks should have their state persisted
        const tasksWithSuccess = finalState.tasks.filter(t => t.lastSuccessTime).length;
        
        // This assertion FAILS when the race condition occurs, demonstrating the bug
        expect(tasksWithSuccess).toBe(3);  // This should fail due to the race condition
        
        // Log the actual result to show the race condition effect
        console.log(`Expected 3 tasks with success time, but got ${tasksWithSuccess} due to race condition`);

        await capabilities.scheduler.stop();
    });
});