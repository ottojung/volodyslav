const path = require("path");
const workingRepository = require("../src/gitstore/working_repository");
const fsp = require("fs/promises");
const { promisify } = require("util");
const { execFile } = require("child_process");
const callSubprocess = promisify(execFile);
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubEventLogRepository } = require("./stubs");
const defaultBranch = require("../src/gitstore/default_branch");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
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
        await workingRepository.synchronize(capabilities);

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
        const repoPath = await workingRepository.getRepository(capabilities);

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

    test("synchronize throws WorkingRepositoryError on git failure", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);

        // Make the eventLogRepository return a non-existent path
        const origEventLogRepo =
            require("../src/environment").eventLogRepository;
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
        const origEventLogRepo =
            require("../src/environment").eventLogRepository;
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
        expect(workingRepository.isWorkingRepositoryError(thrownError)).toBe(
            true
        );

        // Restore original function
        require("../src/environment").eventLogRepository = origEventLogRepo;
    });

    test("synchronize updates remote repository with local changes", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        const localRepoPath = path.join(
            capabilities.environment.workingDirectory(),
            "working-git-repository",
            ".git"
        );

        // Set up a real git repo to clone from
        await stubEventLogRepository(capabilities);

        // Execute synchronize
        await workingRepository.synchronize(capabilities);

        // Modify the local repository
        const newFilePath = path.join(
            capabilities.environment.workingDirectory(),
            "working-git-repository",
            "new-file.txt"
        );
        await fsp.writeFile(newFilePath, "new content");
        await callSubprocess("git add new-file.txt", {
            cwd: path.dirname(localRepoPath),
            shell: true,
        });
        await callSubprocess("git commit -m 'Add new file'", {
            cwd: path.dirname(localRepoPath),
            shell: true,
        });
        await callSubprocess("git push origin", {
            cwd: path.dirname(localRepoPath),
            shell: true,
        });

        // Verify the remote repository contains the new file
        const remoteRepoPath = capabilities.environment.eventLogRepository();

        // Clone the bare remote repository as a non-bare repository
        const clonedRepoPath = await capabilities.creator.createTemporaryDirectory(capabilities);
        await callSubprocess(`git clone --branch ${defaultBranch} ${remoteRepoPath} ${clonedRepoPath}`, {
            shell: true,
        });

        // Verify the new file exists in the cloned repository's working tree
        const clonedFilePath = path.join(clonedRepoPath, "new-file.txt");
        const clonedFileExists = await fsp
            .stat(clonedFilePath)
            .then(() => true)
            .catch(() => false);

        expect(clonedFileExists).toBe(true);
    });

    test("synchronize does not overwrite existing repository", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        const localRepoPath = path.join(
            capabilities.environment.workingDirectory(),
            "working-git-repository",
            ".git"
        );

        // Set up a real git repo to clone from
        await stubEventLogRepository(capabilities);

        // Execute synchronize to create the repository
        await workingRepository.synchronize(capabilities);

        // Modify the local repository
        const newFilePath = path.join(
            capabilities.environment.workingDirectory(),
            "working-git-repository",
            "existing-file.txt"
        );
        await fsp.writeFile(newFilePath, "existing content");
        await callSubprocess("git add existing-file.txt", {
            cwd: path.dirname(localRepoPath),
            shell: true,
        });
        await callSubprocess("git commit -m 'Add existing file'", {
            cwd: path.dirname(localRepoPath),
            shell: true,
        });

        // Execute synchronize again
        await workingRepository.synchronize(capabilities);

        // Verify the existing file is not overwritten
        const existingFileContent = await fsp.readFile(newFilePath, "utf8");
        expect(existingFileContent).toBe("existing content");
    });

    test("synchronize throws error for invalid repository path", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);

        // Mock an invalid repository path
        const origEventLogRepo = capabilities.environment.eventLogRepository;
        capabilities.environment.eventLogRepository = jest.fn().mockReturnValue("/invalid/path");

        // Execute and verify error is thrown
        await expect(
            workingRepository.synchronize(capabilities)
        ).rejects.toThrow("Failed to synchronize repository");

        // Restore original function
        capabilities.environment.eventLogRepository = origEventLogRepo;
    });

    test("push changes to remote repository", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        const localRepoPath = path.join(
            capabilities.environment.workingDirectory(),
            "working-git-repository",
            ".git"
        );

        // Set up a real git repo to clone from
        await stubEventLogRepository(capabilities);

        // Execute synchronize
        await workingRepository.synchronize(capabilities);

        // Modify the local repository
        const newFilePath = path.join(
            capabilities.environment.workingDirectory(),
            "working-git-repository",
            "pushed-file.txt"
        );
        await fsp.writeFile(newFilePath, "pushed content");
        await callSubprocess("git add pushed-file.txt", {
            cwd: path.dirname(localRepoPath),
            shell: true,
        });
        await callSubprocess("git commit -m 'Add pushed file'", {
            cwd: path.dirname(localRepoPath),
            shell: true,
        });
        await callSubprocess("git push origin", {
            cwd: path.dirname(localRepoPath),
            shell: true,
        });

        // Clone the remote repository to verify the pushed changes
        const remoteRepoPath = capabilities.environment.eventLogRepository();
        const clonedRepoPath = await capabilities.creator.createTemporaryDirectory(capabilities);
        await callSubprocess(`git clone --branch ${defaultBranch} ${remoteRepoPath} ${clonedRepoPath}`, {
            shell: true,
        });

        // Verify the pushed file exists in the cloned repository
        const clonedFilePath = path.join(clonedRepoPath, "pushed-file.txt");
        const clonedFileExists = await fsp
            .stat(clonedFilePath)
            .then(() => true)
            .catch(() => false);

        expect(clonedFileExists).toBe(true);

        // Verify the content of the pushed file
        const clonedFileContent = await fsp.readFile(clonedFilePath, "utf8");
        expect(clonedFileContent).toBe("pushed content");
    });
});
