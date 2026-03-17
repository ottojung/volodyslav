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
        await capabilities.git.call(
            "init",
            "--initial-branch",
            branch,
            "--",
            workTree
        );
        const file = await capabilities.creator.createFile(path.join(workTree, fileName));
        await capabilities.writer.writeFile(file, content);
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
 * @param {Array<[string, string, string]>} branches
 * @returns {Promise<void>}
 */
async function seedGeneratorsRemote(capabilities, branches) {
    await capabilities.git.call(
        "init",
        "--bare",
        "--",
        capabilities.environment.generatorsRepository()
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
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "show-ref",
        "--verify",
        "--quiet",
        ref
    ).then(() => true).catch(() => false);
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

/**
 * @param {object} capabilities
 * @param {string} workDirectory
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function hasFileInHead(capabilities, workDirectory, filePath) {
    return capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "show",
        `HEAD:${filePath}`
    ).then(() => true).catch(() => false);
}

/**
 * Returns true when the git call args are a "git clone" command.
 * Since clones now go to a temp dir (for atomicity), we match any clone
 * call instead of requiring a specific destination path.
 * @param {Array<string>} args
 * @returns {boolean}
 */
function isCloneCall(args) {
    return args.includes("clone");
}

describe("generators repository setup", () => {
    test("fresh clone setup can reset to a different remote hostname branch", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        await seedGeneratorsRemote(capabilities, [
            ["test-host", "test-host.txt", "test host branch"],
            ["hello", "hello.txt", "hello branch"],
            ["other", "other.txt", "other branch"],
        ]);

        await workingRepository.synchronize(
            capabilities,
            "generators-working",
            { url: capabilities.environment.generatorsRepository() }
        );

        capabilities.environment.hostname.mockReturnValue("hello");

        await expect(
            workingRepository.synchronize(
                capabilities,
                "generators-working",
                { url: capabilities.environment.generatorsRepository() },
                { resetToTheirs: true }
            )
        ).resolves.toBeUndefined();

        const workDirectory = path.join(
            capabilities.environment.workingDirectory(),
            "generators-working"
        );
        expect(
            await hasRef(
                capabilities,
                workDirectory,
                "refs/remotes/origin/hello-main"
            )
        ).toBe(true);
        expect(
            await hasRef(
                capabilities,
                workDirectory,
                "refs/remotes/origin/other-main"
            )
        ).toBe(true);
        expect(await currentBranch(capabilities, workDirectory)).toBe("hello-main");
    });

    test("synchronize repairs existing single-branch clones so resetToTheirs can use another branch", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        await seedGeneratorsRemote(capabilities, [
            ["test-host", "test-host.txt", "test host branch"],
            ["hello", "hello.txt", "hello branch"],
        ]);

        const workDirectory = path.join(
            capabilities.environment.workingDirectory(),
            "generators-working"
        );
        await capabilities.git.call(
            "clone",
            "--depth=1",
            "--single-branch",
            "--branch=test-host-main",
            "--",
            capabilities.environment.generatorsRepository(),
            workDirectory
        );

        expect(
            await hasRef(
                capabilities,
                workDirectory,
                "refs/remotes/origin/hello-main"
            )
        ).toBe(false);

        capabilities.environment.hostname.mockReturnValue("hello");

        await expect(
            workingRepository.synchronize(
                capabilities,
                "generators-working",
                { url: capabilities.environment.generatorsRepository() },
                { resetToTheirs: true }
            )
        ).resolves.toBeUndefined();

        expect(
            await hasRef(
                capabilities,
                workDirectory,
                "refs/remotes/origin/hello-main"
            )
        ).toBe(true);
        expect(
            await hasRef(
                capabilities,
                workDirectory,
                "refs/heads/hello-main"
            )
        ).toBe(true);
        expect(await currentBranch(capabilities, workDirectory)).toBe("hello-main");
    });

    test("resetToHostname hard-resets current hostname branch to a different hostname branch", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        await seedGeneratorsRemote(capabilities, [
            ["test-host", "test-host.txt", "test host branch"],
            ["alice", "alice.txt", "alice branch"],
        ]);

        await workingRepository.synchronize(
            capabilities,
            "generators-working",
            { url: capabilities.environment.generatorsRepository() }
        );

        await expect(
            workingRepository.synchronize(
                capabilities,
                "generators-working",
                { url: capabilities.environment.generatorsRepository() },
                { resetToHostname: "alice" }
            )
        ).resolves.toBeUndefined();

        const workDirectory = path.join(
            capabilities.environment.workingDirectory(),
            "generators-working"
        );
        expect(await currentBranch(capabilities, workDirectory)).toBe("test-host-main");
        expect(await hasFileInHead(capabilities, workDirectory, "alice.txt")).toBe(true);
        expect(await hasFileInHead(capabilities, workDirectory, "test-host.txt")).toBe(false);
    });

    test("clone setup retries atomically when configuring fetch refspec fails once", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        await seedGeneratorsRemote(capabilities, [["test-host", "test-host.txt", "test host branch"]]);

        let cloneAttempts = 0;
        let fetchConfigFailures = 0;
        const workDirectory = path.join(
            capabilities.environment.workingDirectory(),
            "generators-working"
        );
        const originalGitCall = capabilities.git.call;
        stubGit(capabilities, (...args) => {
            if (isCloneCall(args)) {
                cloneAttempts += 1;
            }
            if (
                args.includes("remote.origin.fetch") &&
                fetchConfigFailures === 0
            ) {
                fetchConfigFailures += 1;
                throw new Error("Simulated fetch refspec setup failure");
            }
            return originalGitCall.apply(capabilities.git, args);
        });

        await expect(
            workingRepository.synchronize(
                capabilities,
                "generators-working",
                { url: capabilities.environment.generatorsRepository() }
            )
        ).resolves.toBeUndefined();

        expect(fetchConfigFailures).toBe(1);
        expect(cloneAttempts).toBe(2);
        expect(await currentBranch(capabilities, workDirectory)).toBe("test-host-main");
    });

    test("clone setup retries atomically when makePushable fails once", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);
        await seedGeneratorsRemote(capabilities, [["test-host", "test-host.txt", "test host branch"]]);

        let cloneAttempts = 0;
        let makePushableFailures = 0;
        const originalGitCall = capabilities.git.call;
        stubGit(capabilities, (...args) => {
            if (isCloneCall(args)) {
                cloneAttempts += 1;
            }
            if (
                args.includes("receive.denyCurrentBranch") &&
                makePushableFailures === 0
            ) {
                makePushableFailures += 1;
                throw new Error("Simulated makePushable failure");
            }
            return originalGitCall.apply(capabilities.git, args);
        });

        await expect(
            workingRepository.synchronize(
                capabilities,
                "generators-working",
                { url: capabilities.environment.generatorsRepository() }
            )
        ).resolves.toBeUndefined();

        expect(makePushableFailures).toBe(1);
        expect(cloneAttempts).toBe(2);
    });
});
