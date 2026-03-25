/**
 * Tests for runtime state storage transactions (DB-backed).
 */

const { RUNTIME_STATE_VERSION } = require("../src/runtime_state_storage/structure");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");
const { fromISOString, toISOString } = require("../src/datetime");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("runtime_state_storage/transaction", () => {
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

    test("transaction fails if DB operations fail", async () => {
        const capabilities = getTestCapabilities();

        // Stub the temporary capability to fail
        capabilities.temporary = {
            getRuntimeState: jest.fn().mockRejectedValue(new Error("DB read failed")),
            setRuntimeState: jest.fn().mockRejectedValue(new Error("DB write failed")),
        };

        const startTime = capabilities.datetime.now();
        const testState = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };

        await expect(capabilities.state.transaction(async (runtimeStateStorage) => {
            runtimeStateStorage.setState(testState);
        })).rejects.toThrow("DB read failed");
    });

    test("transaction propagates write failure and releases mutex", async () => {
        const capabilities = getTestCapabilities();
        const state = { version: RUNTIME_STATE_VERSION, startTime: capabilities.datetime.now(), tasks: [] };

        let shouldFailWrite = true;
        capabilities.temporary = {
            getRuntimeState: jest.fn().mockResolvedValue(null),
            setRuntimeState: jest.fn().mockImplementation(async () => {
                if (shouldFailWrite) {
                    shouldFailWrite = false;
                    throw new Error("DB write failed");
                }
            }),
        };

        await expect(
            capabilities.state.transaction(async (runtimeStateStorage) => {
                runtimeStateStorage.setState(state);
            })
        ).rejects.toThrow("DB write failed");

        await expect(
            capabilities.state.transaction(async (runtimeStateStorage) => {
                runtimeStateStorage.setState(state);
                return "ok";
            })
        ).resolves.toBe("ok");
    });

    test("transaction with no state changes succeeds without committing", async () => {
        const capabilities = getTestCapabilities();

        await expect(
            capabilities.state.transaction(async () => {
                // no state changes - this should be allowed for read-only operations
            })
        ).resolves.not.toThrow();
    });

    test("transaction returns transformation result", async () => {
        const capabilities = getTestCapabilities();

        const expectedResult = { success: true, message: "test completed" };

        const result = await capabilities.state.transaction(async (runtimeStateStorage) => {
            const startTime = capabilities.datetime.now();
            runtimeStateStorage.setState({ version: RUNTIME_STATE_VERSION, startTime, tasks: [] });
            return expectedResult;
        });

        expect(result).toEqual(expectedResult);
    });

    test("transaction provides access to existing state", async () => {
        const capabilities = getTestCapabilities();

        const startTime = fromISOString("2025-01-01T10:00:00.000Z");
        const initialState = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };

        // First transaction: set initial state
        await capabilities.state.transaction(async (runtimeStateStorage) => {
            runtimeStateStorage.setState(initialState);
        });

        // Second transaction: read the existing state
        const result = await capabilities.state.transaction(async (runtimeStateStorage) => {
            const existing = await runtimeStateStorage.getExistingState();
            return existing;
        });

        expect(result).toMatchObject({
            version: RUNTIME_STATE_VERSION,
            startTime: expect.any(Object),
            tasks: []
        });
        expect(toISOString(result.startTime)).toBe("2025-01-01T10:00:00.000Z");
    });

    test("transaction handles missing state gracefully", async () => {
        const capabilities = getTestCapabilities();

        const result = await capabilities.state.transaction(async (runtimeStateStorage) => {
            const existing = await runtimeStateStorage.getExistingState();
            const current = await runtimeStateStorage.getCurrentState();
            return { existing, current };
        });

        expect(result.existing).toBeNull();
        expect(result.current).toMatchObject({
            version: RUNTIME_STATE_VERSION,
            startTime: expect.any(Object),
            tasks: []
        });
    });

    test("transaction updates existing state", async () => {
        const capabilities = getTestCapabilities();

        const initialTime = fromISOString("2025-01-01T10:00:00.000Z");
        const updatedTime = fromISOString("2025-01-01T11:00:00.000Z");

        // Set initial state
        await capabilities.state.transaction(async (runtimeStateStorage) => {
            runtimeStateStorage.setState({ version: RUNTIME_STATE_VERSION, startTime: initialTime, tasks: [] });
        });

        // Update state
        await capabilities.state.transaction(async (runtimeStateStorage) => {
            runtimeStateStorage.setState({ version: RUNTIME_STATE_VERSION, startTime: updatedTime, tasks: [] });
        });

        // Verify update
        const result = await capabilities.state.transaction(async (runtimeStateStorage) => {
            return await runtimeStateStorage.getExistingState();
        });

        expect(toISOString(result.startTime)).toBe("2025-01-01T11:00:00.000Z");
    });

    test("getCurrentState prefers new state over existing", async () => {
        const capabilities = getTestCapabilities();

        const existingTime = fromISOString("2025-01-01T10:00:00.000Z");
        const newTime = fromISOString("2025-01-01T11:00:00.000Z");

        // Set initial state
        await capabilities.state.transaction(async (runtimeStateStorage) => {
            runtimeStateStorage.setState({ version: RUNTIME_STATE_VERSION, startTime: existingTime, tasks: [] });
        });

        // In new transaction, getCurrentState should return new state when set
        const result = await capabilities.state.transaction(async (runtimeStateStorage) => {
            runtimeStateStorage.setState({ version: RUNTIME_STATE_VERSION, startTime: newTime, tasks: [] });
            return await runtimeStateStorage.getCurrentState();
        });

        expect(toISOString(result.startTime)).toBe("2025-01-01T11:00:00.000Z");
    });

    test("transactions are serialized for concurrent callers", async () => {
        const capabilities = getTestCapabilities();
        const order = [];

        const first = capabilities.state.transaction(async (runtimeStateStorage) => {
            order.push("first-start");
            const state = await runtimeStateStorage.getCurrentState();
            state.tasks.push({
                name: "first",
                cronExpression: "* * * * *",
                retryDelayMs: 1000,
            });
            runtimeStateStorage.setState(state);
            await new Promise((resolve) => setTimeout(resolve, 50));
            order.push("first-end");
        });

        const second = capabilities.state.transaction(async (runtimeStateStorage) => {
            order.push("second-start");
            const state = await runtimeStateStorage.getCurrentState();
            state.tasks.push({
                name: "second",
                cronExpression: "* * * * *",
                retryDelayMs: 1000,
            });
            runtimeStateStorage.setState(state);
            order.push("second-end");
        });

        await Promise.all([first, second]);

        expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);

        await capabilities.state.transaction(async (runtimeStateStorage) => {
            const state = await runtimeStateStorage.getCurrentState();
            expect(state.tasks.map((task) => task.name).sort()).toEqual(["first", "second"]);
        });
    });
});
