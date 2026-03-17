const path = require("path");
const workingRepository = require("../src/gitstore/working_repository");
const { getMockedRootCapabilities } = require("./spies");
const { stubDatetime, stubEnvironment, stubGit, stubLogger } = require("./stubs");

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
 * @param {string} fileName
 * @param {string} content
 * @returns {Promise<void>}
 */
async function pushRemoteBranch(capabilities, hostname, fileName, content) {
    const branch = `${hostname}-main`;
    const remotePath = capabilities.environment.generatorsRepository();
    const workTree = await capabilities.creator.createTemporaryDirectory(capabilities);
    try {
        await capabilities.git.call("init", "--initial-branch", branch, "--", workTree);
        const file = await capabilities.creator.createFile(path.join(workTree, fileName));
        await capabilities.writer.writeFile(file, content);
        await capabilities.git.call("-C", workTree, "add", "--all");
        await capabilities.git.call(
            "-C", workTree,
            "-c", "user.name=test-user",
            "-c", "user.email=test@example.com",
            "commit", "-m", `Commit ${branch}`
        );
        await capabilities.git.call("-C", workTree, "remote", "add", "origin", "--", remotePath);
        await capabilities.git.call("-C", workTree, "push", "origin", branch);
    } finally {
        await capabilities.deleter.deleteDirectory(workTree);
    }
}

/**
 * @param {object} capabilities
 * @param {Array<[string, string, string]>} branches
 * @returns {Promise<void>}
 */
async function seedGeneratorsRemote(capabilities, branches) {
    await capabilities.git.call(
        "init", "--bare", "--", capabilities.environment.generatorsRepository()
    );
    for (const [hostname, fileName, content] of branches) {
        await pushRemoteBranch(capabilities, hostname, fileName, content);
    }
}

/**
 * @param {object} capabilities
 * @param {string} workDirectory
 * @param {string} ref
 * @returns {Promise<boolean>}
 */
async function hasRef(capabilities, workDirectory, ref) {
    return capabilities.git.call(
        "-C", workDirectory, "-c", "safe.directory=*",
        "show-ref", "--verify", "--quiet", ref
    ).then(() => true).catch(() => false);
}

describe("generators repository setup – concurrent and fetch efficiency", () => {
    test("concurrent post-clone failure does not corrupt repository set up by another attempt", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        await seedGeneratorsRemote(capabilities, [["test-host", "test-host.txt", "test host branch"]]);

        // Fail configureRemoteForAllBranches on the very first attempt to exercise
        // the temp-dir cleanup path without corrupting a concurrent successful clone.
        let refspecConfigCount = 0;
        const originalGitCall = capabilities.git.call;
        stubGit(capabilities, (...args) => {
            if (args.includes("remote.origin.fetch")) {
                refspecConfigCount += 1;
                if (refspecConfigCount === 1) {
                    throw new Error("Simulated first-attempt refspec config failure");
                }
            }
            return originalGitCall.apply(capabilities.git, args);
        });

        const workDirectory = path.join(
            capabilities.environment.workingDirectory(),
            "generators-concurrent-ownership"
        );

        // Race three synchronize calls: one will hit the setup failure and retry,
        // the others will succeed and set up workDir atomically via temp-dir rename.
        const results = await Promise.allSettled(
            Array.from({ length: 3 }, () =>
                workingRepository.synchronize(
                    capabilities,
                    "generators-concurrent-ownership",
                    { url: capabilities.environment.generatorsRepository() }
                )
            )
        );

        // None should fail permanently.
        for (const result of results) {
            expect(result.status).toBe("fulfilled");
        }

        // The repository must be intact and properly set up.
        expect(
            await hasRef(capabilities, workDirectory, "refs/heads/test-host-main")
        ).toBe(true);
    });

    test("pull uses the already-fetched remote ref and does not fetch twice", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        await seedGeneratorsRemote(capabilities, [["test-host", "test-host.txt", "test host branch"]]);

        // Initial sync to set up the local repository.
        await workingRepository.synchronize(
            capabilities,
            "generators-pull-fetch",
            { url: capabilities.environment.generatorsRepository() }
        );

        // Count fetch calls during the second sync which takes the pull+push path.
        let fetchCount = 0;
        const originalGitCall = capabilities.git.call;
        stubGit(capabilities, (...args) => {
            if (args.includes("fetch") && args.includes("origin")) {
                fetchCount += 1;
            }
            return originalGitCall.apply(capabilities.git, args);
        });

        await workingRepository.synchronize(
            capabilities,
            "generators-pull-fetch",
            { url: capabilities.environment.generatorsRepository() }
        );

        // pull() should fetch exactly once (explicit fetch) and then merge the
        // already-fetched ref – not call git-pull which would fetch a second time.
        expect(fetchCount).toBe(1);
    });
});
