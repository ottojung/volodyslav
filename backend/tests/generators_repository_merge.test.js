const path = require("path");
const workingRepository = require("../src/gitstore/working_repository");
const { isMergeHostBranchesError } = require("../src/gitstore/merge_host_branches");
const { getMockedRootCapabilities } = require("./spies");
const { stubDatetime, stubEnvironment, stubLogger } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    stubLogger(capabilities);
    return capabilities;
}

/**
 * @param {object} capabilities
 * @param {string} hostname
 * @param {Array<[string, string]>} files
 * @returns {Promise<void>}
 */
async function pushRemoteBranch(capabilities, hostname, files) {
    const branch = `${hostname}-main`;
    const remotePath = capabilities.environment.generatorsRepository();
    const workTree = await capabilities.creator.createTemporaryDirectory(capabilities);

    try {
        await capabilities.git.call(
            "init",
            "--initial-branch",
            branch,
            "--",
            workTree
        );
        for (const [fileName, content] of files) {
            const file = await capabilities.creator.createFile(path.join(workTree, fileName));
            await capabilities.writer.writeFile(file, content);
        }
        await capabilities.git.call("-C", workTree, "add", "--all");
        await capabilities.git.call(
            "-C",
            workTree,
            "-c",
            "user.name=test-user",
            "-c",
            "user.email=test@example.com",
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

/**
 * @param {object} capabilities
 * @param {Array<[string, Array<[string, string]>]>} branches
 * @returns {Promise<void>}
 */
async function seedGeneratorsRemote(capabilities, branches) {
    await capabilities.git.call(
        "init",
        "--bare",
        "--",
        capabilities.environment.generatorsRepository()
    );
    for (const [hostname, files] of branches) {
        await pushRemoteBranch(capabilities, hostname, files);
    }
}

/**
 * @param {object} capabilities
 * @param {string} workDirectory
 * @returns {Promise<string>}
 */
async function currentBranch(capabilities, workDirectory) {
    const result = await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "branch",
        "--show-current"
    );
    return result.stdout.trim();
}

describe("generators repository host branch merging", () => {
    test("synchronize merges matching remote hostname branches into the current branch", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        await seedGeneratorsRemote(capabilities, [
            ["test-host", [["test-host.txt", "current host"]]],
            ["alice", [["alice.txt", "alice host"]]],
            ["bob", [["bob.txt", "bob host"]]],
        ]);

        await expect(
            workingRepository.synchronize(
                capabilities,
                "generators-working",
                { url: capabilities.environment.generatorsRepository() },
                { mergeHostBranches: true }
            )
        ).resolves.toBeUndefined();

        const workDirectory = path.join(
            capabilities.environment.workingDirectory(),
            "generators-working"
        );
        expect(await capabilities.reader.readFileAsText(path.join(workDirectory, "test-host.txt"))).toBe("current host");
        expect(await capabilities.reader.readFileAsText(path.join(workDirectory, "alice.txt"))).toBe("alice host");
        expect(await capabilities.reader.readFileAsText(path.join(workDirectory, "bob.txt"))).toBe("bob host");
        expect(await currentBranch(capabilities, workDirectory)).toBe("test-host-main");
    });

    test("synchronize skips remote branches whose names are not valid hostnames", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        await seedGeneratorsRemote(capabilities, [
            ["test-host", [["test-host.txt", "current host"]]],
            ["alice", [["alice.txt", "alice host"]]],
            ["invalid.host", [["invalid.txt", "invalid host branch"]]],
        ]);

        await expect(
            workingRepository.synchronize(
                capabilities,
                "generators-working",
                { url: capabilities.environment.generatorsRepository() },
                { mergeHostBranches: true }
            )
        ).resolves.toBeUndefined();

        const workDirectory = path.join(
            capabilities.environment.workingDirectory(),
            "generators-working"
        );
        expect(await capabilities.reader.readFileAsText(path.join(workDirectory, "alice.txt"))).toBe("alice host");
        expect(
            await capabilities.checker.fileExists(path.join(workDirectory, "invalid.txt"))
        ).toBe(null);
    });

    test("synchronize records merge failures by hostname and keeps merging other hosts", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        await seedGeneratorsRemote(capabilities, [
            ["test-host", [["shared.txt", "current host"]]],
            ["alice", [["shared.txt", "alice host"]]],
            ["bob", [["bob.txt", "bob host"]]],
            ["carol", [["shared.txt", "carol host"]]],
        ]);

        let thrownError = null;
        try {
            await workingRepository.synchronize(
                capabilities,
                "generators-working",
                { url: capabilities.environment.generatorsRepository() },
                { mergeHostBranches: true }
            );
        } catch (error) {
            thrownError = error;
        }

        expect(thrownError).not.toBeNull();
        expect(isMergeHostBranchesError(thrownError)).toBe(true);
        expect(workingRepository.isWorkingRepositoryError(thrownError)).toBe(false);
        expect(String(thrownError)).toContain(
            "Failed to merge generators database branches:\n- alice:"
        );
        expect(String(thrownError)).toContain("- carol:");

        const workDirectory = path.join(
            capabilities.environment.workingDirectory(),
            "generators-working"
        );
        expect(await capabilities.reader.readFileAsText(path.join(workDirectory, "bob.txt"))).toBe("bob host");
        expect(await capabilities.reader.readFileAsText(path.join(workDirectory, "shared.txt"))).toBe("current host");
    });
});
