const workingRepository = require("../src/gitstore/working_repository");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
} = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("working_repository", () => {
    test("synchronize throws WorkingRepositoryError on git failure", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);

        // Make the eventLogRepository return a non-existent path
        const origEventLogRepo = require("../src/environment").eventLogRepository;
        require("../src/environment").eventLogRepository = jest
            .fn()
            .mockReturnValue("/nonexistent/repo");

        // Execute and verify error is thrown with the expected message
        await expect(
            workingRepository.synchronize(capabilities, "working-git-repository", capabilities.environment.eventLogRepository())
        ).rejects.toThrow("Failed to synchronize repository");

        // Restore original function
        require("../src/environment").eventLogRepository = origEventLogRepo;
    }, 30000);

    // Separate test for WorkingRepositoryError type checking
    test("errors from synchronize are WorkingRepositoryError instances", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);

        // Make the eventLogRepository return a non-existent path
        const origEventLogRepo = require("../src/environment").eventLogRepository;
        require("../src/environment").eventLogRepository = jest
            .fn()
            .mockReturnValue("/nonexistent/repo");

        // Execute and save the error
        let thrownError = null;
        try {
            await workingRepository.synchronize(capabilities, "working-git-repository", capabilities.environment.eventLogRepository());
        } catch (error) {
            thrownError = error;
        }

        // Verify error is of the correct type
        expect(thrownError).not.toBeNull();
        expect(workingRepository.isWorkingRepositoryError(thrownError)).toBe(true);

        // Restore original function
        require("../src/environment").eventLogRepository = origEventLogRepo;
    }, 30000);

    test("synchronize throws error for invalid repository path", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);

        // Mock an invalid repository path
        const origEventLogRepo = capabilities.environment.eventLogRepository;
        capabilities.environment.eventLogRepository = jest
            .fn()
            .mockReturnValue("/invalid/path");

        // Execute and verify error is thrown
        await expect(
            workingRepository.synchronize(capabilities, "working-git-repository", capabilities.environment.eventLogRepository())
        ).rejects.toThrow("Failed to synchronize repository");

        // Restore original function
        capabilities.environment.eventLogRepository = origEventLogRepo;
    }, 30000);

    test("resetAndCleanRepository fails fast when merge abort fails and merge state persists", async () => {
        const capabilities = getTestCapabilities();
        const workDir = `${capabilities.environment.workingDirectory()}/working-git-repository`;

        capabilities.checker.fileExists = jest.fn(async (path) => {
            if (path === `${workDir}/.git/MERGE_HEAD`) {
                return {};
            }
            return null;
        });
        capabilities.checker.directoryExists = jest.fn(async () => null);

        capabilities.git.call = jest.fn(async (...args) => {
            const command = args.join(" ");
            if (command.includes(" merge --abort")) {
                throw new Error("fatal: merge --abort failed");
            }
            return { stdout: "", stderr: "" };
        });

        const result = await workingRepository
            .resetAndCleanRepository(capabilities, "working-git-repository")
            .catch((error) => error);
        expect(capabilities.checker.fileExists).toHaveBeenCalledWith(`${workDir}/.git/MERGE_HEAD`);
        expect(capabilities.checker.fileExists.mock.calls.length).toBeGreaterThanOrEqual(2);
        expect(workingRepository.isWorkingRepositoryError(result)).toBe(true);
        expect(result.message).toContain("Failed to abort merge");
    });
});
