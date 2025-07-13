const path = require("path");
const workingRepository = require("../src/gitstore/working_repository");
const fsp = require("fs/promises");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    stubEventLogRepository,
} = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("working_repository", () => {
    test("synchronize creates working repository when it doesn't exist", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        const localRepoPath = path.join(
            capabilities.environment.workingDirectory(),
            "working-git-repository",
            ".git"
        );

        // Set up a real git repo to clone from
        await stubEventLogRepository(capabilities);

        // Ensure the repository doesn't exist before synchronization.
        const indexExistsBeforeSync = await fsp
            .stat(path.join(localRepoPath, "index"))
            .then(() => true)
            .catch(() => false);

        expect(indexExistsBeforeSync).toBe(false);

        // Execute synchronize
        await workingRepository.synchronize(capabilities, "working-git-repository", capabilities.environment.eventLogRepository());

        // Verify the repository was created and has the index file
        const indexExists = await fsp
            .stat(path.join(localRepoPath, "index"))
            .then(() => true)
            .catch(() => false);

        expect(indexExists).toBe(true);
    });

    test("getRepository returns the correct repository path", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);

        // Set up a real git repo to clone from
        await stubEventLogRepository(capabilities);

        // Execute getRepository (which should trigger synchronize)
        const repoPath = await workingRepository.getRepository(capabilities, "working-git-repository", capabilities.environment.eventLogRepository());

        // Verify correct path is returned
        const expectedPath = path.join(
            capabilities.environment.workingDirectory(),
            "working-git-repository",
            ".git"
        );
        expect(repoPath).toBe(expectedPath);

        // Verify the repo actually exists
        const indexExists = await fsp
            .stat(path.join(expectedPath, "index"))
            .then(() => true)
            .catch(() => false);

        expect(indexExists).toBe(true);
    });
});

