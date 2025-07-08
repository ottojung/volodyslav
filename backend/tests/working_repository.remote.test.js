const path = require("path");
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
        await workingRepository.synchronize(capabilities);

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
        await workingRepository.synchronize(capabilities);

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
        await workingRepository.synchronize(capabilities);

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
        await workingRepository.synchronize(capabilities);

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
});

