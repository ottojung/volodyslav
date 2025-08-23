/**
 * Tests for runtime state storage class.
 */

const { make: makeRuntimeStateStorage } = require("../src/runtime_state_storage/class");
const { RUNTIME_STATE_VERSION } = require("../src/runtime_state_storage/structure");
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
        const mockFile = { path: "/mock/state.json" };
        const storage = makeRuntimeStateStorage(capabilities, mockFile);
        expect(storage).toBeDefined();
        expect(storage.capabilities).toBe(capabilities);
    });

    test("setState stores new state", () => {
        const capabilities = getTestCapabilities();
        const mockFile = { path: "/mock/state.json" };
        const storage = makeRuntimeStateStorage(capabilities, mockFile);
        const startTime = capabilities.datetime.now();
        const state = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };

        storage.setState(state);
        expect(storage.getNewState()).toEqual(state);
    });

    test("getNewState returns null initially", () => {
        const capabilities = getTestCapabilities();
        const mockFile = { path: "/mock/state.json" };
        const storage = makeRuntimeStateStorage(capabilities, mockFile);
        expect(storage.getNewState()).toBeNull();
    });

    test("getExistingState returns null when no state file exists", async () => {
        const capabilities = getTestCapabilities();
        
        // Mock file path and simulate file not found error
        const mockFile = { path: "/mock/state.json" };
        const storage = makeRuntimeStateStorage(capabilities, mockFile);
        
        capabilities.reader.readFileAsText = jest.fn().mockImplementation(() => {
            throw new Error("File not found");
        });
        
        const result = await storage.getExistingState();
        expect(result).toBeNull();
        expect(capabilities.logger.logWarning).toHaveBeenCalledWith(
            expect.objectContaining({
                filepath: "/mock/state.json",
                error: "File not found"
            }),
            "Failed to read runtime state file"
        );
    });

    test("getExistingState caches results", async () => {
        const capabilities = getTestCapabilities();
        
        // Mock file path and simulate file not found error
        const mockFile = { path: "/mock/state.json" };
        const storage = makeRuntimeStateStorage(capabilities, mockFile);
        
        capabilities.reader.readFileAsText = jest.fn().mockImplementation(() => {
            throw new Error("File not found");
        });
        
        const result1 = await storage.getExistingState();
        const result2 = await storage.getExistingState();
        
        expect(result1).toBe(result2);
        expect(result1).toBeNull();
        // Verify that readFileAsText was only called once due to caching
        expect(capabilities.reader.readFileAsText).toHaveBeenCalledTimes(1);
    });

    test("getExistingState handles invalid JSON", async () => {
        const capabilities = getTestCapabilities();
        
        // Mock file that exists but contains invalid JSON
        const mockFile = { path: "/mock/state.json" };
        const storage = makeRuntimeStateStorage(capabilities, mockFile);
        
        capabilities.reader.readFileAsText = jest.fn().mockResolvedValue("invalid json");
        
        const result = await storage.getExistingState();
        expect(result).toBeNull();
        expect(capabilities.logger.logWarning).toHaveBeenCalled();
    });

    test("getExistingState handles invalid state structure", async () => {
        const capabilities = getTestCapabilities();
        
        // Mock file that exists but contains invalid state structure
        const mockFile = { path: "/mock/state.json" };
        const storage = makeRuntimeStateStorage(capabilities, mockFile);
        
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
        
        // Mock file that exists and contains valid state
        const mockFile = { path: "/mock/state.json" };
        const storage = makeRuntimeStateStorage(capabilities, mockFile);
        
        const validState = {
            version: RUNTIME_STATE_VERSION,
            startTime: "2025-01-01T10:00:00.000Z",
            tasks: []
        };
        
        capabilities.reader.readFileAsText = jest.fn().mockResolvedValue(
            JSON.stringify(validState)
        );
        
        const result = await storage.getExistingState();
        expect(result).toMatchObject({
            version: RUNTIME_STATE_VERSION,
            startTime: expect.any(Object),
            tasks: []
        });
    });

    test("getCurrentState returns new state when set", async () => {
        const capabilities = getTestCapabilities();
        const mockFile = { path: "/mock/state.json" };
        const storage = makeRuntimeStateStorage(capabilities, mockFile);
        
        const startTime = capabilities.datetime.now();
        const state = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };
        storage.setState(state);
        
        const result = await storage.getCurrentState();
        expect(result).toEqual(state);
    });

    test("getCurrentState returns existing state when no new state", async () => {
        const capabilities = getTestCapabilities();
        
        // Mock existing state
        const mockFile = { path: "/mock/state.json" };
        const storage = makeRuntimeStateStorage(capabilities, mockFile);
        
        const existingState = {
            version: RUNTIME_STATE_VERSION,
            startTime: "2025-01-01T10:00:00.000Z",
            tasks: []
        };
        
        capabilities.reader.readFileAsText = jest.fn().mockResolvedValue(
            JSON.stringify(existingState)
        );
        
        const result = await storage.getCurrentState();
        expect(result).toMatchObject({
            version: RUNTIME_STATE_VERSION,
            startTime: expect.any(Object),
            tasks: []
        });
    });

    test("getCurrentState creates default state when none exists", async () => {
        const capabilities = getTestCapabilities();
        
        // Mock file path and simulate file not found error
        const mockFile = { path: "/mock/state.json" };
        const storage = makeRuntimeStateStorage(capabilities, mockFile);
        
        capabilities.reader.readFileAsText = jest.fn().mockImplementation(() => {
            throw new Error("File not found");
        });
        
        const result = await storage.getCurrentState();
        expect(result).toMatchObject({
            version: RUNTIME_STATE_VERSION,
            startTime: expect.any(Object),
            tasks: []
        });
    });
});
