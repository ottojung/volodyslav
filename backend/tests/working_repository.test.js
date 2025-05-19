const path = require("path");
const workingRepository = require("../src/gitstore/working_repository");
const fsp = require("fs/promises");
const { execFile } = require("child_process");
const { promisify } = require("util");
const temporary = require("./temporary");
const { getMockedRootCapabilities } = require("./mockCapabilities");
const logger = require("../src/logger");
const makeTestRepository = require("./make_test_repository");

const callSubprocess = promisify(execFile);

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

// Mock environment exports to avoid real env dependencies
jest.mock("../src/environment", () => {
    const temporary = require("./temporary");
    const path = require("path");
    return {
        logLevel: jest.fn().mockReturnValue("debug"),
        logFile: jest.fn().mockImplementation(() => {
            return path.join(temporary.output(), "log.txt");
        }),
        workingDirectory: jest.fn().mockImplementation(() => {
            return path.join(temporary.output(), "working-git-repository");
        }),
        eventLogRepository: jest.fn().mockImplementation(() => {
            const dir = temporary.input();
            return path.join(dir, "remote-repo");
        }),
        eventLogDirectory: jest.fn().mockImplementation(() => {
            const dir = temporary.input();
            return path.join(dir, "event_log");
        }),
    };
});

describe("working_repository", () => {
    test("synchronize creates working repository when it doesn't exist", async () => {
        await logger.setup();
        const capabilities = getMockedRootCapabilities();

        // Set up a real git repo to clone from
        await makeTestRepository();

        // Execute synchronize
        await workingRepository.synchronize(capabilities);

        // Verify the repository was created and has the index file
        const localRepoPath = path.join(
            temporary.output(),
            "working-git-repository"
        );
        const indexExists = await fsp
            .stat(path.join(localRepoPath, "index"))
            .then(() => true)
            .catch(() => false);

        expect(indexExists).toBe(true);
    });

    test("getRepository returns the correct repository path", async () => {
        await logger.setup();
        const capabilities = getMockedRootCapabilities();

        // Set up a real git repo to clone from
        await makeTestRepository();

        // Execute getRepository (which should trigger synchronize)
        const repoPath = await workingRepository.getRepository(capabilities);

        // Verify correct path is returned
        const expectedPath = path.join(
            temporary.output(),
            "working-git-repository"
        );
        expect(repoPath).toBe(expectedPath);

        // Verify the repo actually exists
        const indexExists = await fsp
            .stat(path.join(expectedPath, "index"))
            .then(() => true)
            .catch(() => false);

        expect(indexExists).toBe(true);
    });

    test("synchronize throws WorkingRepositoryError on git failure", async () => {
        await logger.setup();
        const capabilities = getMockedRootCapabilities();

        // Make the eventLogRepository return a non-existent path
        const origEventLogRepo =
            require("../src/environment").eventLogRepository;
        require("../src/environment").eventLogRepository = jest
            .fn()
            .mockReturnValue("/nonexistent/repo");

        // Execute and verify error is thrown and matches expected pattern
        let error;
        try {
            await workingRepository.synchronize(capabilities);
            fail("Expected synchronize to throw an error");
        } catch (e) {
            error = e;
        }

        expect(error.message).toMatch(/Failed to synchronize repository/);
        expect(workingRepository.isWorkingRepositoryError(error)).toBe(true);

        // Restore original function
        require("../src/environment").eventLogRepository = origEventLogRepo;
    });
});
