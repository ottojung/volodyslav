/**
 * Tests for runtime state storage transactions.
 */

const { transaction } = require("../src/runtime_state_storage");
const { RUNTIME_STATE_VERSION } = require("../src/runtime_state_storage/structure");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    
    // Don't mock git.call - let it work with real git operations
    // The repository will be initialized automatically
    
    return capabilities;
}

describe("runtime_state_storage/transaction", () => {
    test("transaction allows setting and storing runtime state", async () => {
        const capabilities = getTestCapabilities();

        const startTime = capabilities.datetime.fromISOString("2025-01-01T10:00:00.000Z");
        const testState = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };

        await transaction(capabilities, async (runtimeStateStorage) => {
            runtimeStateStorage.setState(testState);
        });

        // Verify the state was stored by reading it in another transaction
        await transaction(capabilities, async (runtimeStateStorage) => {
            const storedState = await runtimeStateStorage.getExistingState();
            expect(storedState).toMatchObject({
                version: RUNTIME_STATE_VERSION,
                startTime: expect.any(Object),
                tasks: []
            });
            // Check that the stored time matches what we set
            expect(capabilities.datetime.toISOString(storedState.startTime)).toBe("2025-01-01T10:00:00.000Z");
        });
    });

    test("transaction fails if git operations fail", async () => {
        const capabilities = getTestCapabilities();
        
        // Mock git.call to fail for this specific test
        capabilities.git.call = jest.fn().mockRejectedValue(new Error("Git operation failed"));

        const startTime = capabilities.datetime.now();
        const testState = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };

        await expect(
            transaction(capabilities, async (runtimeStateStorage) => {
                runtimeStateStorage.setState(testState);
            })
        ).rejects.toThrow();
    });

    test("transaction with no state changes succeeds without committing", async () => {
        const capabilities = getTestCapabilities();

        await expect(
            transaction(capabilities, async () => {
                // no state changes - this should be allowed for read-only operations
            })
        ).resolves.not.toThrow();
    });

    test("transaction returns transformation result", async () => {
        const capabilities = getTestCapabilities();

        const expectedResult = { success: true, message: "test completed" };

        const result = await transaction(capabilities, async (runtimeStateStorage) => {
            const startTime = capabilities.datetime.now();
            runtimeStateStorage.setState({ version: RUNTIME_STATE_VERSION, startTime, tasks: [] });
            return expectedResult;
        });

        expect(result).toEqual(expectedResult);
    });

    test("transaction provides access to existing state", async () => {
        const capabilities = getTestCapabilities();

        const startTime = capabilities.datetime.fromISOString("2025-01-01T10:00:00.000Z");
        const initialState = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };

        // First transaction: set initial state
        await transaction(capabilities, async (runtimeStateStorage) => {
            runtimeStateStorage.setState(initialState);
        });

        // Second transaction: read the existing state
        const result = await transaction(capabilities, async (runtimeStateStorage) => {
            const existing = await runtimeStateStorage.getExistingState();
            return existing;
        });

        expect(result).toMatchObject({
            version: RUNTIME_STATE_VERSION,
            startTime: expect.any(Object),
            tasks: []
        });
        expect(capabilities.datetime.toISOString(result.startTime)).toBe("2025-01-01T10:00:00.000Z");
    });

    test("transaction handles missing state file gracefully", async () => {
        const capabilities = getTestCapabilities();

        const result = await transaction(capabilities, async (runtimeStateStorage) => {
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

        const initialTime = capabilities.datetime.fromISOString("2025-01-01T10:00:00.000Z");
        const updatedTime = capabilities.datetime.fromISOString("2025-01-01T11:00:00.000Z");

        // Set initial state
        await transaction(capabilities, async (runtimeStateStorage) => {
            runtimeStateStorage.setState({ version: RUNTIME_STATE_VERSION, startTime: initialTime, tasks: [] });
        });

        // Update state
        await transaction(capabilities, async (runtimeStateStorage) => {
            runtimeStateStorage.setState({ version: RUNTIME_STATE_VERSION, startTime: updatedTime, tasks: [] });
        });

        // Verify update
        const result = await transaction(capabilities, async (runtimeStateStorage) => {
            return await runtimeStateStorage.getExistingState();
        });

        expect(capabilities.datetime.toISOString(result.startTime)).toBe("2025-01-01T11:00:00.000Z");
    });

    test("getCurrentState prefers new state over existing", async () => {
        const capabilities = getTestCapabilities();

        const existingTime = capabilities.datetime.fromISOString("2025-01-01T10:00:00.000Z");
        const newTime = capabilities.datetime.fromISOString("2025-01-01T11:00:00.000Z");

        // Set initial state
        await transaction(capabilities, async (runtimeStateStorage) => {
            runtimeStateStorage.setState({ version: RUNTIME_STATE_VERSION, startTime: existingTime, tasks: [] });
        });

        // In new transaction, getCurrentState should return new state when set
        const result = await transaction(capabilities, async (runtimeStateStorage) => {
            runtimeStateStorage.setState({ version: RUNTIME_STATE_VERSION, startTime: newTime, tasks: [] });
            return await runtimeStateStorage.getCurrentState();
        });

        expect(capabilities.datetime.toISOString(result.startTime)).toBe("2025-01-01T11:00:00.000Z");
    });
});
