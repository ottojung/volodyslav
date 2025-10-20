/**
 * Fast tests for runtime state storage transactions using mocked implementation.
 * These tests demonstrate the performance improvement from using in-memory storage.
 */

const { RUNTIME_STATE_VERSION } = require("../src/runtime_state_storage/structure");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubRuntimeStateStorage } = require("./stubs");
const { fromISOString, toISOString } = require("../src/datetime");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubRuntimeStateStorage(capabilities);
    return capabilities;
}

describe("runtime_state_storage/transaction (mocked)", () => {
    test("transaction allows setting and storing runtime state", async () => {
        const capabilities = getTestCapabilities();
        

        const startTime = fromISOString("2025-01-01T10:00:00.000Z");
        const testState = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };

        await capabilities.state.transaction(async (runtimeStateStorage) => {
            runtimeStateStorage.setState(testState);
        });

        // Verify the state was stored by reading it in another transaction
        await capabilities.state.transaction(async (runtimeStateStorage) => {
            const storedState = await runtimeStateStorage.getExistingState();
            expect(storedState).toMatchObject({
                version: RUNTIME_STATE_VERSION,
                startTime: expect.any(Object),
                tasks: []
            });
            // Check that the stored time matches what we set
            expect(toISOString(storedState.startTime)).toBe("2025-01-01T10:00:00.000Z");
        });
    });

    test("transaction succeeds without git operations", async () => {
        const capabilities = getTestCapabilities();
        

        const startTime = capabilities.datetime.now();
        const testState = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };

        // This should succeed without any git operations
        await expect(
            capabilities.state.transaction(async (runtimeStateStorage) => {
                runtimeStateStorage.setState(testState);
            })
        ).resolves.toBeUndefined();
    });

    test("transaction with no state changes succeeds without committing", async () => {
        const capabilities = getTestCapabilities();
        

        await expect(
            capabilities.state.transaction(async (runtimeStateStorage) => {
                // Don't set any state
                const state = await runtimeStateStorage.getCurrentState();
                expect(state).toBeDefined();
            })
        ).resolves.toBeUndefined();
    });

    test("transaction returns transformation result", async () => {
        const capabilities = getTestCapabilities();
        

        const expectedResult = "test-result";
        const result = await capabilities.state.transaction(async (_runtimeStateStorage) => {
            return expectedResult;
        });

        expect(result).toBe(expectedResult);
    });

    test("transaction provides access to existing state", async () => {
        const capabilities = getTestCapabilities();
        

        const startTime = fromISOString("2025-01-01T10:00:00.000Z");
        const testState = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };

        // Set up existing state
        await capabilities.state.transaction(async (runtimeStateStorage) => {
            runtimeStateStorage.setState(testState);
        });

        // Access existing state in new transaction
        await capabilities.state.transaction(async (runtimeStateStorage) => {
            const existingState = await runtimeStateStorage.getExistingState();
            expect(existingState).toMatchObject({
                version: RUNTIME_STATE_VERSION,
                startTime: expect.any(Object),
                tasks: []
            });
            expect(toISOString(existingState.startTime)).toBe("2025-01-01T10:00:00.000Z");
        });
    });

    test("transaction handles missing state file gracefully", async () => {
        const capabilities = getTestCapabilities();
        

        await capabilities.state.transaction(async (runtimeStateStorage) => {
            const existingState = await runtimeStateStorage.getExistingState();
            expect(existingState).toBeNull();

            const currentState = await runtimeStateStorage.getCurrentState();
            expect(currentState).toMatchObject({
                version: RUNTIME_STATE_VERSION,
                startTime: expect.any(Object),
                tasks: []
            });
        });
    });

    test("transaction updates existing state", async () => {
        const capabilities = getTestCapabilities();
        

        const initialTime = fromISOString("2025-01-01T10:00:00.000Z");
        const updatedTime = fromISOString("2025-01-01T11:00:00.000Z");
        
        const initialState = { version: RUNTIME_STATE_VERSION, startTime: initialTime, tasks: [] };
        const updatedState = { version: RUNTIME_STATE_VERSION, startTime: updatedTime, tasks: [] };

        // Set initial state
        await capabilities.state.transaction(async (runtimeStateStorage) => {
            runtimeStateStorage.setState(initialState);
        });

        // Update state
        await capabilities.state.transaction(async (runtimeStateStorage) => {
            runtimeStateStorage.setState(updatedState);
        });

        // Verify updated state
        await capabilities.state.transaction(async (runtimeStateStorage) => {
            const storedState = await runtimeStateStorage.getExistingState();
            expect(toISOString(storedState.startTime)).toBe("2025-01-01T11:00:00.000Z");
        });
    });

    test("getCurrentState prefers new state over existing", async () => {
        const capabilities = getTestCapabilities();
        

        const existingTime = fromISOString("2025-01-01T10:00:00.000Z");
        const newTime = fromISOString("2025-01-01T11:00:00.000Z");
        
        const existingState = { version: RUNTIME_STATE_VERSION, startTime: existingTime, tasks: [] };
        const newState = { version: RUNTIME_STATE_VERSION, startTime: newTime, tasks: [] };

        // Set up existing state
        await capabilities.state.transaction(async (runtimeStateStorage) => {
            runtimeStateStorage.setState(existingState);
        });

        // Test that new state takes priority
        await capabilities.state.transaction(async (runtimeStateStorage) => {
            runtimeStateStorage.setState(newState);
            const currentState = await runtimeStateStorage.getCurrentState();
            expect(toISOString(currentState.startTime)).toBe("2025-01-01T11:00:00.000Z");
        });
    });

    test("handles complex state with tasks", async () => {
        const capabilities = getTestCapabilities();
        

        const startTime = capabilities.datetime.now();
        const lastSuccess = fromISOString("2025-01-01T09:00:00.000Z");
        const lastFailure = fromISOString("2025-01-01T08:00:00.000Z");
        
        const complexState = {
            version: RUNTIME_STATE_VERSION,
            startTime,
            tasks: [
                {
                    name: "task-1",
                    cronExpression: "0 * * * *",
                    retryDelayMs: 5000,
                    lastSuccessTime: lastSuccess,
                },
                {
                    name: "task-2",
                    cronExpression: "0,15,30,45 * * * *",
                    retryDelayMs: 30000,
                    lastFailureTime: lastFailure,
                }
            ]
        };

        await capabilities.state.transaction(async (runtimeStateStorage) => {
            runtimeStateStorage.setState(complexState);
        });

        await capabilities.state.transaction(async (runtimeStateStorage) => {
            const storedState = await runtimeStateStorage.getExistingState();
            expect(storedState.tasks).toHaveLength(2);
            expect(storedState.tasks[0].name).toBe("task-1");
            expect(storedState.tasks[1].name).toBe("task-2");
            expect(toISOString(storedState.tasks[0].lastSuccessTime)).toBe("2025-01-01T09:00:00.000Z");
            expect(toISOString(storedState.tasks[1].lastFailureTime)).toBe("2025-01-01T08:00:00.000Z");
        });
    });
});