const path = require("path");
const { execFileSync } = require("child_process");
const workingRepository = require("../src/gitstore/working_repository");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    stubEventLogRepository,
} = require("./stubs");
const defaultBranch = require("../src/gitstore/default_branch");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

/**
 * @param {string} repositoryPath
 * @param {string} filePath
 * @returns {string}
 */
function fileContentAtHead(repositoryPath, filePath) {
    return execFileSync("git", [
        "-C",
        repositoryPath,
        "show",
        `HEAD:${filePath}`,
    ]).toString();
}

describe("working_repository", () => {
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
        await workingRepository.synchronize(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() });

        // Modify the local repository
        const newFilePath = path.join(
            capabilities.environment.workingDirectory(),
            "working-git-repository",
            "new-file.txt"
        );
        const newFile = await capabilities.creator.createFile(newFilePath);
        await capabilities.writer.writeFile(newFile, "new content");
        await capabilities.git.call(
            "-C",
            path.dirname(localRepoPath),
            "add",
            "new-file.txt"
        );
        await capabilities.git.call(
            "-C",
            path.dirname(localRepoPath),
            "-c",
            "user.name=volodyslav",
            "-c",
            "user.email=volodyslav",
            "commit",
            "-m",
            "Add new file"
        );
        await capabilities.git.call(
            "-C",
            path.dirname(localRepoPath),
            "push",
            "origin"
        );

        // Verify the remote repository contains the new file
        const remoteRepoPath = capabilities.environment.eventLogRepository();

        // Clone the bare remote repository as a non-bare repository
        const clonedRepoPath =
            await capabilities.creator.createTemporaryDirectory(capabilities);
        await capabilities.git.call(
            "clone",
            `--branch=${defaultBranch}`,
            remoteRepoPath,
            clonedRepoPath
        );

        // Verify the new file exists in the cloned repository's working tree
        const clonedFilePath = path.join(clonedRepoPath, "new-file.txt");
        const clonedFileExists =
            (await capabilities.checker.fileExists(clonedFilePath)) !== null;

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
        await workingRepository.synchronize(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() });

        // Modify the local repository
        const newFilePath = path.join(
            capabilities.environment.workingDirectory(),
            "working-git-repository",
            "existing-file.txt"
        );
        const existingFile = await capabilities.creator.createFile(newFilePath);
        await capabilities.writer.writeFile(existingFile, "existing content");
        await capabilities.git.call(
            "-C",
            path.dirname(localRepoPath),
            "add",
            "existing-file.txt"
        );
        await capabilities.git.call(
            "-C",
            path.dirname(localRepoPath),
            "-c",
            "user.name=volodyslav",
            "-c",
            "user.email=volodyslav",
            "commit",
            "-m",
            "Add existing file"
        );

        // Execute synchronize again
        await workingRepository.synchronize(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() });

        // Verify the existing file is not overwritten
        const existingFileContent = await capabilities.reader.readFileAsText(
            newFilePath
        );
        expect(existingFileContent).toBe("existing content");
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
        await workingRepository.synchronize(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() });

        // Modify the local repository
        const newFilePath = path.join(
            capabilities.environment.workingDirectory(),
            "working-git-repository",
            "pushed-file.txt"
        );
        const pushedFile = await capabilities.creator.createFile(newFilePath);
        await capabilities.writer.writeFile(pushedFile, "pushed content");
        await capabilities.git.call(
            "-C",
            path.dirname(localRepoPath),
            "add",
            "pushed-file.txt"
        );
        await capabilities.git.call(
            "-C",
            path.dirname(localRepoPath),
            "-c",
            "user.name=volodyslav",
            "-c",
            "user.email=volodyslav",
            "commit",
            "-m",
            "Add pushed file"
        );
        await capabilities.git.call(
            "-C",
            path.dirname(localRepoPath),
            "push",
            "origin"
        );

        // Clone the remote repository to verify the pushed changes
        const remoteRepoPath = capabilities.environment.eventLogRepository();
        const clonedRepoPath =
            await capabilities.creator.createTemporaryDirectory(capabilities);
        await capabilities.git.call(
            "clone",
            `--branch=${defaultBranch}`,
            remoteRepoPath,
            clonedRepoPath
        );

        // Verify the pushed file exists in the cloned repository
        const clonedFilePath = path.join(clonedRepoPath, "pushed-file.txt");
        const clonedFileExists =
            (await capabilities.checker.fileExists(clonedFilePath)) !== null;

        expect(clonedFileExists).toBe(true);

        // Verify the content of the pushed file
        const clonedFileContent = await capabilities.reader.readFileAsText(
            clonedFilePath
        );
        expect(clonedFileContent).toBe("pushed content");
    });

    test("synchronize succeeds when local repo exists but has no origin configured", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);

        // Set up a remote repository (bare repo, accepts pushes without configuration)
        await stubEventLogRepository(capabilities);
        const remoteRepoPath = capabilities.environment.eventLogRepository();

        // Create a local repository WITHOUT origin by using the "empty" initial state
        // path (this is what initializeEmptyRepository does — no remote is configured)
        await workingRepository.getRepository(capabilities, "working-git-repository", "empty");

        const localWorkDir = path.join(
            capabilities.environment.workingDirectory(),
            "working-git-repository"
        );

        // Confirm origin is NOT configured before synchronize
        const hasOriginBefore = await capabilities.git.call(
            "-C", localWorkDir, "-c", "safe.directory=*",
            "remote", "get-url", "origin"
        ).then(() => true).catch(() => false);
        expect(hasOriginBefore).toBe(false);

        // synchronize should not throw even though origin is absent
        await expect(
            workingRepository.synchronize(
                capabilities,
                "working-git-repository",
                { url: remoteRepoPath }
            )
        ).resolves.not.toThrow();

        // After synchronize, origin must be configured in the local repo
        const hasOriginAfter = await capabilities.git.call(
            "-C", localWorkDir, "-c", "safe.directory=*",
            "remote", "get-url", "origin"
        ).then(() => true).catch(() => false);
        expect(hasOriginAfter).toBe(true);
    });

    test("synchronize refreshes a stale checked-out work tree before pull and push", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        await stubEventLogRepository(capabilities);

        await workingRepository.synchronize(
            capabilities,
            "working-git-repository",
            { url: capabilities.environment.eventLogRepository() }
        );

        const localWorkDir = path.join(
            capabilities.environment.workingDirectory(),
            "working-git-repository"
        );
        const temporaryClone = await capabilities.creator.createTemporaryDirectory(capabilities);
        const remoteVerificationClone = await capabilities.creator.createTemporaryDirectory(capabilities);

        try {
            await capabilities.git.call("clone", localWorkDir, temporaryClone);
            const trackedFile = path.join(temporaryClone, "data.json");
            const trackedOutput = await capabilities.creator.createFile(trackedFile);
            await capabilities.writer.writeFile(trackedOutput, '{"events":["stale-head-update"]}');
            await capabilities.git.call("-C", temporaryClone, "add", "data.json");
            await capabilities.git.call(
                "-C",
                temporaryClone,
                "-c",
                "user.name=volodyslav",
                "-c",
                "user.email=volodyslav",
                "commit",
                "-m",
                "Advance local repo head only"
            );
            await capabilities.git.call("-C", temporaryClone, "push", "origin", defaultBranch);

            expect(await capabilities.reader.readFileAsText(path.join(localWorkDir, "data.json")))
                .not.toBe('{"events":["stale-head-update"]}');
            expect(fileContentAtHead(localWorkDir, "data.json"))
                .toBe('{"events":["stale-head-update"]}');

            await expect(
                workingRepository.synchronize(
                    capabilities,
                    "working-git-repository",
                    { url: capabilities.environment.eventLogRepository() }
                )
            ).resolves.toBeUndefined();

            expect(await capabilities.reader.readFileAsText(path.join(localWorkDir, "data.json")))
                .toBe('{"events":["stale-head-update"]}');

            await capabilities.git.call(
                "clone",
                `--branch=${defaultBranch}`,
                capabilities.environment.eventLogRepository(),
                remoteVerificationClone
            );
            expect(await capabilities.reader.readFileAsText(path.join(remoteVerificationClone, "data.json")))
                .toBe('{"events":["stale-head-update"]}');
        } finally {
            await capabilities.deleter.deleteDirectory(temporaryClone);
            await capabilities.deleter.deleteDirectory(remoteVerificationClone);
        }
    });

    test("synchronize removes stale untracked files that would block checkout updates", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        await stubEventLogRepository(capabilities);

        await workingRepository.synchronize(
            capabilities,
            "working-git-repository",
            { url: capabilities.environment.eventLogRepository() }
        );

        const localWorkDir = path.join(
            capabilities.environment.workingDirectory(),
            "working-git-repository"
        );
        const blockingFile = path.join(localWorkDir, "conflict.txt");
        const createdBlockingFile = await capabilities.creator.createFile(blockingFile);
        await capabilities.writer.writeFile(createdBlockingFile, "local untracked blocker");

        const temporaryClone = await capabilities.creator.createTemporaryDirectory(capabilities);
        try {
            await capabilities.git.call("clone", localWorkDir, temporaryClone);
            const trackedConflict = await capabilities.creator.createFile(path.join(temporaryClone, "conflict.txt"));
            await capabilities.writer.writeFile(trackedConflict, "tracked from head");
            await capabilities.git.call("-C", temporaryClone, "add", "conflict.txt");
            await capabilities.git.call(
                "-C",
                temporaryClone,
                "-c",
                "user.name=volodyslav",
                "-c",
                "user.email=volodyslav",
                "commit",
                "-m",
                "Add conflict file"
            );
            await capabilities.git.call("-C", temporaryClone, "push", "origin", defaultBranch);

            await expect(
                workingRepository.synchronize(
                    capabilities,
                    "working-git-repository",
                    { url: capabilities.environment.eventLogRepository() }
                )
            ).resolves.toBeUndefined();

            expect(await capabilities.reader.readFileAsText(blockingFile)).toBe("tracked from head");
        } finally {
            await capabilities.deleter.deleteDirectory(temporaryClone);
        }
    });
});
