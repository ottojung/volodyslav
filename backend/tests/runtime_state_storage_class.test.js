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
        const storage = makeRuntimeStateStorage(capabilities, null);
        expect(storage).toBeDefined();
        expect(storage.capabilities).toBe(capabilities);
    });

    test("setState stores new state", () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities, null);
        const startTime = capabilities.datetime.now();
        const state = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };

        storage.setState(state);
        expect(storage.getNewState()).toEqual(state);
    });

    test("getNewState returns null initially", () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities, null);
        expect(storage.getNewState()).toBeNull();
    });

    test("getExistingState returns null when no data in DB", async () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities, null);

        const result = await storage.getExistingState();
        expect(result).toBeNull();
        expect(capabilities.logger.logWarning).not.toHaveBeenCalled();
    });

    test("getExistingState caches results for null data", async () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities, null);

        const result1 = await storage.getExistingState();
        const result2 = await storage.getExistingState();

        expect(result1).toBe(result2);
        expect(result1).toBeNull();
    });

    test("getExistingState throws on invalid state structure", async () => {
        const capabilities = getTestCapabilities();
        const invalidData = { invalid: "structure" };
        const storage = makeRuntimeStateStorage(capabilities, invalidData);

        await expect(storage.getExistingState()).rejects.toThrow("Runtime state file is corrupted");
        const error = await storage.getExistingState().catch(e => e);
        expect(error.name).toBe("RuntimeStateCorruptedError");
        expect(error.deserializeError.message).toContain("Missing required field: startTime");
    });

    test("getExistingState parses valid state from DB data", async () => {
        const capabilities = getTestCapabilities();
        const validData = {
            version: RUNTIME_STATE_VERSION,
            startTime: "2025-01-01T10:00:00.000Z",
            tasks: []
        };
        const storage = makeRuntimeStateStorage(capabilities, validData);

        const result = await storage.getExistingState();
        expect(result).toMatchObject({
            version: RUNTIME_STATE_VERSION,
            startTime: expect.any(Object),
            tasks: []
        });
    });

    test("getExistingState caches valid state", async () => {
        const capabilities = getTestCapabilities();
        const validData = {
            version: RUNTIME_STATE_VERSION,
            startTime: "2025-01-01T10:00:00.000Z",
            tasks: []
        };
        const storage = makeRuntimeStateStorage(capabilities, validData);

        const result1 = await storage.getExistingState();
        const result2 = await storage.getExistingState();
        expect(result1).toBe(result2);
    });

    test("getCurrentState returns new state when set", async () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities, null);

        const startTime = capabilities.datetime.now();
        const state = { version: RUNTIME_STATE_VERSION, startTime, tasks: [] };
        storage.setState(state);

        const result = await storage.getCurrentState();
        expect(result).toEqual(state);
    });

    test("getCurrentState returns existing state when no new state", async () => {
        const capabilities = getTestCapabilities();
        const existingData = {
            version: RUNTIME_STATE_VERSION,
            startTime: "2025-01-01T10:00:00.000Z",
            tasks: []
        };
        const storage = makeRuntimeStateStorage(capabilities, existingData);

        const result = await storage.getCurrentState();
        expect(result).toMatchObject({
            version: RUNTIME_STATE_VERSION,
            startTime: expect.any(Object),
            tasks: []
        });
    });

    test("getCurrentState creates default state when no data in DB", async () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities, null);

        const result = await storage.getCurrentState();
        expect(result).toMatchObject({
            version: RUNTIME_STATE_VERSION,
            startTime: expect.any(Object),
            tasks: []
        });
    });

    test("getCurrentState throws on corrupted state data", async () => {
        const capabilities = getTestCapabilities();
        const storage = makeRuntimeStateStorage(capabilities, { invalid: "structure" });

        await expect(storage.getCurrentState()).rejects.toThrow("Runtime state file is corrupted");
    });

    test("getExistingState logs migration when migrating from v1", async () => {
        const capabilities = getTestCapabilities();
        const legacyData = {
            version: 1,
            startTime: "2025-01-01T10:00:00.000Z",
        };
        const storage = makeRuntimeStateStorage(capabilities, legacyData);

        const result = await storage.getExistingState();
        expect(result).toMatchObject({
            version: RUNTIME_STATE_VERSION,
            startTime: expect.any(Object),
            tasks: []
        });
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({ fromVersion: 1, toVersion: RUNTIME_STATE_VERSION }),
            "RuntimeStateMigrated"
        );
    });
});
