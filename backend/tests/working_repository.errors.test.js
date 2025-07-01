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
            workingRepository.synchronize(capabilities)
        ).rejects.toThrow("Failed to synchronize repository");

        // Restore original function
        require("../src/environment").eventLogRepository = origEventLogRepo;
    });

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
            await workingRepository.synchronize(capabilities);
        } catch (error) {
            thrownError = error;
        }

        // Verify error is of the correct type
        expect(thrownError).not.toBeNull();
        expect(workingRepository.isWorkingRepositoryError(thrownError)).toBe(true);

        // Restore original function
        require("../src/environment").eventLogRepository = origEventLogRepo;
    });

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
            workingRepository.synchronize(capabilities)
        ).rejects.toThrow("Failed to synchronize repository");

        // Restore original function
        capabilities.environment.eventLogRepository = origEventLogRepo;
    });
});

