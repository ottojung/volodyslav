/**
 * Tests for runtime state storage synchronize module.
 */

const { ensureAccessible, isRuntimeStateStorageAccessError } = require("../src/runtime_state_storage/synchronize");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("runtime_state_storage/synchronize", () => {
    test("ensureAccessible returns void when DB is accessible", async () => {
        const capabilities = getTestCapabilities();

        // Stub the temporary capability to succeed
        capabilities.temporary = {
            getRuntimeState: jest.fn().mockResolvedValue(null),
        };

        const result = await ensureAccessible(capabilities);
        expect(result).toBeUndefined();
        expect(capabilities.temporary.getRuntimeState).toHaveBeenCalledTimes(1);
    });

    test("ensureAccessible throws RuntimeStateStorageAccessError on DB failure", async () => {
        const capabilities = getTestCapabilities();

        // Stub the temporary capability to fail
        capabilities.temporary = {
            getRuntimeState: jest.fn().mockRejectedValue(new Error("DB open failed")),
        };

        await expect(ensureAccessible(capabilities)).rejects.toThrow(
            "Failed to ensure runtime state storage is accessible"
        );
    });

    test("ensureAccessible error is a RuntimeStateStorageAccessError", async () => {
        const capabilities = getTestCapabilities();

        capabilities.temporary = {
            getRuntimeState: jest.fn().mockRejectedValue(new Error("DB open failed")),
        };

        const error = await ensureAccessible(capabilities).catch(e => e);
        expect(isRuntimeStateStorageAccessError(error)).toBe(true);
        expect(error.name).toBe("RuntimeStateStorageAccessError");
    });
});
