/**
 * Tests for runtime state storage synchronize module.
 */

const { synchronize, ensureAccessible } = require("../src/runtime_state_storage/synchronize");
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
    test("ensureAccessible creates repository if it doesn't exist", async () => {
        const capabilities = getTestCapabilities();
        
        // Mock that the repository doesn't exist initially
        capabilities.checker.fileExists = jest.fn().mockResolvedValue(false);
        
        // Manually mock git.call since automatic mocking doesn't work for this
        capabilities.git.call = jest.fn().mockResolvedValue({ stdout: "", stderr: "" });
        
        const gitDir = await ensureAccessible(capabilities);
        
        expect(gitDir).toContain("runtime-state-repository");
        expect(gitDir).toContain(".git");
        expect(capabilities.creator.createDirectory).toHaveBeenCalled();
        expect(capabilities.git.call).toHaveBeenCalledWith(
            "-C",
            expect.stringContaining("runtime-state-repository"),
            "-c",
            "safe.directory=*",
            "-c",
            "user.name=volodyslav",
            "-c",
            "user.email=volodyslav",
            "init",
            "--initial-branch",
            "master"
        );
    });

    test("ensureAccessible returns existing repository path", async () => {
        const capabilities = getTestCapabilities();
        
        // Mock that the repository already exists
        capabilities.checker.fileExists = jest.fn().mockResolvedValue(true);
        
        // Mock git.call even though it shouldn't be called
        capabilities.git.call = jest.fn().mockResolvedValue({ stdout: "", stderr: "" });
        
        const gitDir = await ensureAccessible(capabilities);
        
        expect(gitDir).toContain("runtime-state-repository");
        expect(gitDir).toContain(".git");
        // Should not create directory or initialize git if it already exists
        expect(capabilities.creator.createDirectory).not.toHaveBeenCalled();
    });

    test("synchronize calls ensureAccessible", async () => {
        const capabilities = getTestCapabilities();
        
        // Mock that the repository already exists
        capabilities.checker.fileExists = jest.fn().mockResolvedValue(true);
        
        // Mock git.call even though it shouldn't be called
        capabilities.git.call = jest.fn().mockResolvedValue({ stdout: "", stderr: "" });
        
        await synchronize(capabilities);
        
        // Should have checked for the index file
        expect(capabilities.checker.fileExists).toHaveBeenCalled();
    });

    test("ensureAccessible throws error when git init fails", async () => {
        const capabilities = getTestCapabilities();
        
        // Mock that the repository doesn't exist
        capabilities.checker.fileExists = jest.fn().mockResolvedValue(false);
        
        // Mock git init failure
        capabilities.git.call = jest.fn().mockRejectedValue(new Error("Git init failed"));
        
        await expect(ensureAccessible(capabilities)).rejects.toThrow(
            "Failed to initialize runtime state repository"
        );
    });

    test("ensureAccessible logs initialization messages", async () => {
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
            "Initializing runtime state repository"
        );
        
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({
                repository: expect.stringContaining("runtime-state-repository")
            }),
            "Runtime state repository initialized"
        );
    });

    test("ensureAccessible handles createDirectory failure", async () => {
        const capabilities = getTestCapabilities();
        
        // Mock that the repository doesn't exist
        capabilities.checker.fileExists = jest.fn().mockResolvedValue(false);
        
        // Mock directory creation failure
        capabilities.creator.createDirectory = jest.fn().mockRejectedValue(new Error("Directory creation failed"));
        
        await expect(ensureAccessible(capabilities)).rejects.toThrow(
            "Failed to initialize runtime state repository"
        );
    });
});
