/**
 * Tests for runtime state storage synchronize module.
 */

const { ensureAccessible } = require("../src/runtime_state_storage/synchronize");
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
    test("ensureAccessible returns void", async () => {
        const capabilities = getTestCapabilities();
        
        // Mock git.call to succeed for repository operations
        capabilities.git.call = jest.fn().mockResolvedValue({ stdout: "", stderr: "" });
        
        const gitDir = await ensureAccessible(capabilities);
        
        expect(gitDir).toBeUndefined();
    });

    test("ensureAccessible throws RuntimeStateRepositoryError on failure", async () => {
        const capabilities = getTestCapabilities();
        
        // Mock git init failure
        capabilities.git.call = jest.fn().mockRejectedValue(new Error("Git init failed"));
        
        await expect(ensureAccessible(capabilities)).rejects.toThrow(
            "Failed to ensure runtime state repository is accessible"
        );
    });

    test("ensureAccessible logs empty repository initialization", async () => {
        const capabilities = getTestCapabilities();
        
        // Mock that the repository doesn't exist initially
        capabilities.checker.fileExists = jest.fn().mockResolvedValue(false);
        
        // Mock git.call to succeed
        capabilities.git.call = jest.fn().mockResolvedValue({ stdout: "", stderr: "" });
        
        await ensureAccessible(capabilities);
        
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({
                repository: expect.stringContaining("runtime-state-repository")
            }),
            "Initializing empty repository"
        );
    });
});
