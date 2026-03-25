/**
 * Tests for runtime state storage mock implementation.
 */

const { mockRuntimeStateTransaction, stubRuntimeStateStorage, isMockRuntimeStateStorage } = require("./stubs");
const { RUNTIME_STATE_VERSION } = require("../src/runtime_state_storage/structure");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");
const { fromISOString, toISOString } = require("../src/datetime");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubRuntimeStateStorage(capabilities);
    return capabilities;
}

describe("runtime_state_storage mock", () => {
    test("mockRuntimeStateTransaction provides same interface", async () => {
        const capabilities = getTestCapabilities();

        await mockRuntimeStateTransaction(capabilities, async (storage) => {
            expect(storage).toBeDefined();
            expect(typeof storage.setState).toBe("function");
            expect(typeof storage.getNewState).toBe("function");
            expect(typeof storage.getExistingState).toBe("function");
            expect(typeof storage.getCurrentState).toBe("function");
        });
    });

    test("mock storage allows setting and getting state", async () => {
        const capabilities = getTestCapabilities();
        const startTime = capabilities.datetime.now();
        const testState = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };

        await mockRuntimeStateTransaction(capabilities, async (storage) => {
            storage.setState(testState);
            expect(storage.getNewState()).toEqual(testState);
        });
    });

    test("mock storage persists state between transactions", async () => {
        const capabilities = getTestCapabilities();
        const startTime = fromISOString("2025-01-01T10:00:00.000Z");
        const testState = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };

        // First transaction: set state
        await mockRuntimeStateTransaction(capabilities, async (storage) => {
            storage.setState(testState);
        });

        // Second transaction: retrieve state
        await mockRuntimeStateTransaction(capabilities, async (storage) => {
            const retrievedState = await storage.getExistingState();
            expect(retrievedState).toMatchObject({
                version: RUNTIME_STATE_VERSION,
                startTime: expect.any(Object),
                tasks: []
            });
            expect(toISOString(retrievedState.startTime)).toBe("2025-01-01T10:00:00.000Z");
        });
    });

    test("mock storage returns default state when none exists", async () => {
        const capabilities = getTestCapabilities();

        await mockRuntimeStateTransaction(capabilities, async (storage) => {
            const currentState = await storage.getCurrentState();
            expect(currentState).toMatchObject({
                version: RUNTIME_STATE_VERSION,
                startTime: expect.any(Object),
                tasks: []
            });
        });
    });

    test("mock storage prioritizes new state over existing", async () => {
        const capabilities = getTestCapabilities();
        const existingTime = fromISOString("2025-01-01T10:00:00.000Z");
        const newTime = fromISOString("2025-01-01T11:00:00.000Z");

        const existingState = { version: RUNTIME_STATE_VERSION, startTime: existingTime, tasks: [] };
        const newState = { version: RUNTIME_STATE_VERSION, startTime: newTime, tasks: [] };

        // Set up existing state
        await mockRuntimeStateTransaction(capabilities, async (storage) => {
            storage.setState(existingState);
        });

        // Test that new state takes priority
        await mockRuntimeStateTransaction(capabilities, async (storage) => {
            storage.setState(newState);
            const currentState = await storage.getCurrentState();
            expect(toISOString(currentState.startTime)).toBe("2025-01-01T11:00:00.000Z");
        });
    });

    test("stubRuntimeStateStorage replaces capabilities.state", async () => {
        const capabilities = getTestCapabilities();

        // Before stubbing, capabilities.state should exist and be mocked by getMockedRootCapabilities
        expect(capabilities.state).toBeDefined();
        expect(jest.isMockFunction(capabilities.state.transaction)).toBe(true);
        expect(jest.isMockFunction(capabilities.state.ensureAccessible)).toBe(true);

        // Store references to the original mocked functions
        const originalTransaction = capabilities.state.transaction;
        const originalEnsureAccessible = capabilities.state.ensureAccessible;

        // Apply the stub
        stubRuntimeStateStorage(capabilities);

        // Verify it's been replaced with our specific mock implementation
        expect(capabilities.state).toBeDefined();
        expect(capabilities.state.transaction).toBeDefined();
        expect(jest.isMockFunction(capabilities.state.transaction)).toBe(true);
        expect(capabilities.state.ensureAccessible).toBeDefined();
        expect(jest.isMockFunction(capabilities.state.ensureAccessible)).toBe(true);

        // Verify the functions have been replaced (not the same mock instances)
        expect(capabilities.state.transaction).not.toBe(originalTransaction);
        expect(capabilities.state.ensureAccessible).not.toBe(originalEnsureAccessible);

        // Test that the mock works
        const startTime = capabilities.datetime.now();
        const testState = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };

        await capabilities.state.transaction(async (storage) => {
            storage.setState(testState);
            expect(storage.getNewState()).toEqual(testState);
        });
    });

    test("isMockRuntimeStateStorage type guard works", async () => {
        const capabilities = getTestCapabilities();

        await mockRuntimeStateTransaction(capabilities, async (storage) => {
            expect(isMockRuntimeStateStorage(storage)).toBe(true);
            expect(isMockRuntimeStateStorage({})).toBe(false);
            expect(isMockRuntimeStateStorage(null)).toBe(false);
        });
    });

    test("mock storage handles complex state with tasks", async () => {
        const capabilities = getTestCapabilities();
        const startTime = capabilities.datetime.now();
        const lastSuccess = fromISOString("2025-01-01T09:00:00.000Z");

        const testState = {
            version: RUNTIME_STATE_VERSION,
            startTime,
            tasks: [
                {
                    name: "test-task",
                    cronExpression: "0 * * * *",
                    retryDelayMs: 5000,
                    lastSuccessTime: lastSuccess,
                }
            ]
        };

        await mockRuntimeStateTransaction(capabilities, async (storage) => {
            storage.setState(testState);
        });

        await mockRuntimeStateTransaction(capabilities, async (storage) => {
            const retrievedState = await storage.getExistingState();
            expect(retrievedState).toMatchObject({
                version: RUNTIME_STATE_VERSION,
                startTime: expect.any(Object),
                tasks: [
                    {
                        name: "test-task",
                        cronExpression: "0 * * * *",
                        retryDelayMs: 5000,
                        lastSuccessTime: expect.any(Object),
                    }
                ]
            });
            expect(toISOString(retrievedState.tasks[0].lastSuccessTime)).toBe("2025-01-01T09:00:00.000Z");
        });
    });

    test("mockRuntimeStateTransaction works without capabilities.state being set up", async () => {
        // Use a minimal capabilities object — no capabilities.state property at all.
        const capabilities = getMockedRootCapabilities();
        stubLogger(capabilities);
        stubDatetime(capabilities);

        const startTime = fromISOString("2025-01-01T10:00:00.000Z");
        const testState = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };

        // Should work without stubRuntimeStateStorage having been called.
        await mockRuntimeStateTransaction(capabilities, async (storage) => {
            storage.setState(testState);
        });

        await mockRuntimeStateTransaction(capabilities, async (storage) => {
            const existingState = await storage.getExistingState();
            expect(existingState).not.toBeNull();
            expect(toISOString(existingState.startTime)).toBe("2025-01-01T10:00:00.000Z");
        });
    });

    test("mockRuntimeStateTransaction serializes concurrent callers", async () => {
        const capabilities = getTestCapabilities();
        const order = [];

        const first = mockRuntimeStateTransaction(capabilities, async (storage) => {
            order.push("first-start");
            await new Promise((resolve) => setTimeout(resolve, 20));
            const state = await storage.getCurrentState();
            state.tasks.push({ name: "first", cronExpression: "* * * * *", retryDelayMs: 0 });
            storage.setState(state);
            order.push("first-end");
        });

        const second = mockRuntimeStateTransaction(capabilities, async (storage) => {
            order.push("second-start");
            const state = await storage.getCurrentState();
            state.tasks.push({ name: "second", cronExpression: "* * * * *", retryDelayMs: 0 });
            storage.setState(state);
            order.push("second-end");
        });

        await Promise.all([first, second]);

        expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);

        await mockRuntimeStateTransaction(capabilities, async (storage) => {
            const state = await storage.getCurrentState();
            expect(state.tasks.map((t) => t.name).sort()).toEqual(["first", "second"]);
        });
    });

    test("mockRuntimeStateTransaction does not write state when transformation throws", async () => {
        const capabilities = getTestCapabilities();

        const startTime = fromISOString("2025-01-01T10:00:00.000Z");
        const initialState = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };

        await mockRuntimeStateTransaction(capabilities, async (storage) => {
            storage.setState(initialState);
        });

        const updatedTime = fromISOString("2025-06-01T00:00:00.000Z");
        await expect(
            mockRuntimeStateTransaction(capabilities, async (storage) => {
                storage.setState({ version: RUNTIME_STATE_VERSION, startTime: updatedTime, tasks: [] });
                throw new Error("transformation failed");
            })
        ).rejects.toThrow("transformation failed");

        // State should still be the original
        await mockRuntimeStateTransaction(capabilities, async (storage) => {
            const existing = await storage.getExistingState();
            expect(toISOString(existing.startTime)).toBe("2025-01-01T10:00:00.000Z");
        });
    });

    test("mockRuntimeStateTransaction releases mutex after transformation throws", async () => {
        const capabilities = getTestCapabilities();

        await expect(
            mockRuntimeStateTransaction(capabilities, async () => {
                throw new Error("failed");
            })
        ).rejects.toThrow("failed");

        // Subsequent transaction should succeed
        const result = await mockRuntimeStateTransaction(capabilities, async () => {
            return "ok";
        });
        expect(result).toBe("ok");
    });
});
