const path = require("path");
const workingRepository = require("../src/gitstore/working_repository");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
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
 * @param {ReturnType<typeof getTestCapabilities>} capabilities
 * @param {string} branch
 * @param {Array<[string, string]>} files
 * @returns {Promise<void>}
 */
async function pushBranch(capabilities, branch, files) {
    const remotePath = capabilities.environment.eventLogRepository();
    const workTree = await capabilities.creator.createTemporaryDirectory(capabilities);

    try {
        await capabilities.git.call("init", "--initial-branch", branch, "--", workTree);
        for (const [name, content] of files) {
            const file = await capabilities.creator.createFile(path.join(workTree, name));
            await capabilities.writer.writeFile(file, content);
        }
        await capabilities.git.call("-C", workTree, "add", "--all");
        await capabilities.git.call(
            "-C",
            workTree,
            "-c",
            "user.name=volodyslav",
            "-c",
            "user.email=volodyslav",
            "commit",
            "-m",
            `Commit ${branch}`
        );
        await capabilities.git.call("-C", workTree, "remote", "add", "origin", "--", remotePath);
        await capabilities.git.call("-C", workTree, "push", "origin", branch);
    } finally {
        await capabilities.deleter.deleteDirectory(workTree);
    }
}

describe("working_repository reset semantics", () => {
    test("resetToHostname force-pushes current-host branch to avoid divergence", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);

        const remoteRepoPath = capabilities.environment.eventLogRepository();
        const currentBranch = defaultBranch(capabilities);
        await capabilities.git.call("init", "--bare", "--", remoteRepoPath);

        await pushBranch(capabilities, currentBranch, [["current.txt", "current host"]]);
        await pushBranch(capabilities, "alice-main", [["alice.txt", "alice host"]]);

        await workingRepository.synchronize(
            capabilities,
            "working-git-repository",
            { url: remoteRepoPath },
            { resetToHostname: "alice" }
        );

        const verifyTree = await capabilities.creator.createTemporaryDirectory(capabilities);
        try {
            await capabilities.git.call(
                "clone",
                `--branch=${currentBranch}`,
                remoteRepoPath,
                verifyTree
            );
            expect(
                await capabilities.checker.fileExists(path.join(verifyTree, "alice.txt"))
            ).not.toBeNull();
            expect(
                await capabilities.checker.fileExists(path.join(verifyTree, "current.txt"))
            ).toBeNull();
        } finally {
            await capabilities.deleter.deleteDirectory(verifyTree);
        }
    });

    test("normal synchronize succeeds after cross-host reset-to-hostname", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);

        const remoteRepoPath = capabilities.environment.eventLogRepository();
        const currentBranch = defaultBranch(capabilities);
        await capabilities.git.call("init", "--bare", "--", remoteRepoPath);
        await pushBranch(capabilities, currentBranch, [["current.txt", "current host"]]);
        await pushBranch(capabilities, "alice-main", [["alice.txt", "alice host"]]);

        await workingRepository.synchronize(
            capabilities,
            "working-git-repository",
            { url: remoteRepoPath },
            { resetToHostname: "alice" }
        );

        await expect(workingRepository.synchronize(
            capabilities,
            "working-git-repository",
            { url: remoteRepoPath }
        )).resolves.toBeUndefined();

        const verifyTree = await capabilities.creator.createTemporaryDirectory(capabilities);
        try {
            await capabilities.git.call(
                "clone",
                `--branch=${currentBranch}`,
                remoteRepoPath,
                verifyTree
            );
            expect(
                await capabilities.checker.fileExists(path.join(verifyTree, "alice.txt"))
            ).not.toBeNull();
        } finally {
            await capabilities.deleter.deleteDirectory(verifyTree);
        }
    });

    test("resetToHostname does not merge host branches when local repository already exists", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);

        const remoteRepoPath = capabilities.environment.eventLogRepository();
        const currentBranch = defaultBranch(capabilities);
        await capabilities.git.call("init", "--bare", "--", remoteRepoPath);
        await pushBranch(capabilities, currentBranch, [["current.txt", "current host"]]);
        await pushBranch(capabilities, "alice-main", [["alice.txt", "alice host"]]);
        await pushBranch(capabilities, "zed-main", [["zed.txt", "zed host"]]);

        await workingRepository.synchronize(
            capabilities,
            "working-git-repository",
            { url: remoteRepoPath }
        );

        const originalGitCall = capabilities.git.call;
        capabilities.git.call = jest.fn().mockImplementation((...args) => {
            if (args.includes("merge")) {
                throw new Error("merge must not run in reset mode");
            }
            return originalGitCall.apply(capabilities.git, args);
        });

        await expect(workingRepository.synchronize(
            capabilities,
            "working-git-repository",
            { url: remoteRepoPath },
            { resetToHostname: "alice", mergeHostBranches: true }
        )).resolves.toBeUndefined();
    });

    test("resetToHostname does not merge host branches when local repository does not exist", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);

        const remoteRepoPath = capabilities.environment.eventLogRepository();
        const currentBranch = defaultBranch(capabilities);
        await capabilities.git.call("init", "--bare", "--", remoteRepoPath);
        await pushBranch(capabilities, currentBranch, [["current.txt", "current host"]]);
        await pushBranch(capabilities, "alice-main", [["alice.txt", "alice host"]]);
        await pushBranch(capabilities, "zed-main", [["zed.txt", "zed host"]]);

        const originalGitCall = capabilities.git.call;
        capabilities.git.call = jest.fn().mockImplementation((...args) => {
            if (args.includes("merge")) {
                throw new Error("merge must not run in reset mode");
            }
            return originalGitCall.apply(capabilities.git, args);
        });

        await expect(workingRepository.synchronize(
            capabilities,
            "working-git-repository",
            { url: remoteRepoPath },
            { resetToHostname: "alice", mergeHostBranches: true }
        )).resolves.toBeUndefined();
    });
});
