/**
 * Tests for runtime state storage class.
 */

const { make: makeRuntimeStateStorage } = require("../src/runtime_state_storage/class");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("runtime_state_storage/class", () => {
    test("makeRuntimeStateStorage creates storage instance", () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities);
        expect(storage).toBeDefined();
        expect(storage.capabilities).toBe(capabilities);
    });

    test("setState stores new state", () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities);
        const startTime = capabilities.datetime.now();
        const state = { startTime };

        storage.setState(state);
        expect(storage.getNewState()).toEqual(state);
    });

    test("getNewState returns null initially", () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities);
        expect(storage.getNewState()).toBeNull();
    });

    test("getExistingState returns null when no state file exists", async () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities);
        
        // Simulate being inside a transaction with no state file
        storage.stateFile = null;
        
        const result = await storage.getExistingState();
        expect(result).toBeNull();
    });

    test("getExistingState caches results", async () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities);
        
        // Simulate being inside a transaction with no state file
        storage.stateFile = null;
        
        const result1 = await storage.getExistingState();
        const result2 = await storage.getExistingState();
        
        expect(result1).toBe(result2);
        expect(result1).toBeNull();
    });

    test("getExistingState handles invalid JSON", async () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities);
        
        // Mock file that exists but contains invalid JSON
        const mockFile = { path: "/mock/state.json" };
        storage.stateFile = mockFile;
        
        capabilities.reader.readFileAsText = jest.fn().mockResolvedValue("invalid json");
        
        const result = await storage.getExistingState();
        expect(result).toBeNull();
        expect(capabilities.logger.logWarning).toHaveBeenCalled();
    });

    test("getExistingState handles invalid state structure", async () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities);
        
        // Mock file that exists but contains invalid state structure
        const mockFile = { path: "/mock/state.json" };
        storage.stateFile = mockFile;
        
        capabilities.reader.readFileAsText = jest.fn().mockResolvedValue(
            JSON.stringify({ invalid: "structure" })
        );
        
        const result = await storage.getExistingState();
        expect(result).toBeNull();
        expect(capabilities.logger.logWarning).toHaveBeenCalledWith(
            expect.objectContaining({
                filepath: "/mock/state.json",
                error: expect.stringContaining("Missing required field: startTime")
            }),
            "Found invalid runtime state object in file"
        );
    });

    test("getExistingState parses valid state", async () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities);
        
        // Mock file that exists and contains valid state
        const mockFile = { path: "/mock/state.json" };
        storage.stateFile = mockFile;
        
        const validState = {
            startTime: "2025-01-01T10:00:00.000Z"
        };
        
        capabilities.reader.readFileAsText = jest.fn().mockResolvedValue(
            JSON.stringify(validState)
        );
        
        const result = await storage.getExistingState();
        expect(result).toMatchObject({
            startTime: expect.any(Object)
        });
    });

    test("getCurrentState returns new state when set", async () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities);
        
        const startTime = capabilities.datetime.now();
        const state = { startTime };
        storage.setState(state);
        
        const result = await storage.getCurrentState();
        expect(result).toEqual(state);
    });

    test("getCurrentState returns existing state when no new state", async () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities);
        
        // Mock existing state
        const mockFile = { path: "/mock/state.json" };
        storage.stateFile = mockFile;
        
        const existingState = {
            startTime: "2025-01-01T10:00:00.000Z"
        };
        
        capabilities.reader.readFileAsText = jest.fn().mockResolvedValue(
            JSON.stringify(existingState)
        );
        
        const result = await storage.getCurrentState();
        expect(result).toMatchObject({
            startTime: expect.any(Object)
        });
    });

    test("getCurrentState creates default state when none exists", async () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities);
        
        // Mock no existing state file
        storage.stateFile = null;
        
        const result = await storage.getCurrentState();
        expect(result).toMatchObject({
            startTime: expect.any(Object)
        });
    });
});
