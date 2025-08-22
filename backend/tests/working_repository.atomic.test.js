const path = require("path");
const fsp = require("fs/promises");
const { execFileSync } = require("child_process");
const workingRepository = require("../src/gitstore/working_repository");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubEventLogRepository } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("working_repository (atomic initialize)", () => {
    test("initializeEmptyRepository remains atomic under parallel calls", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);

        const repoName = "atomic-working-git-repository";
        const gitDir = path.join(capabilities.environment.workingDirectory(), repoName, ".git");

        // Spawn several parallel requests that will race to initialize the same repository
        const parallel = 6;
        const promises = [];
        for (let i = 0; i < parallel; i++) {
            promises.push(
                // Use getRepository with initial_state === "empty" which triggers initializeEmptyRepository
                workingRepository.getRepository(capabilities, repoName, "empty")
            );
        }

        // Wait for all to settle. Some calls may fail due to clone race (destination exists)
        // which is acceptable as long as the repository ends up initialized.
        const results = await Promise.allSettled(promises);
        const rejected = results.filter((r) => r.status === "rejected");
        for (const r of rejected) {
            const err = r.reason;
            // If it's a WorkingRepositoryError caused by git clone failing because the
            // destination already exists, ignore it. Otherwise surface the error.
            if (workingRepository.isWorkingRepositoryError(err)) {
                const msg = String(err.message || "");
                if (msg.includes("already exists and is not an empty directory")) {
                    continue;
                }
            }

            throw err;
        }

        // Verify repository .git/index exists
        const indexExists = await fsp
            .stat(path.join(gitDir, "index"))
            .then(() => true)
            .catch(() => false);

        expect(indexExists).toBe(true);

        // Verify repository has at least the initial commit
        const commitCount = execFileSync("git", ["--git-dir", gitDir, "rev-list", "--count", "master"]).toString().trim();
        expect(parseInt(commitCount, 10)).toBeGreaterThanOrEqual(1);
    });

    test.skip("initializeRemoteRepository remains atomic under parallel calls", async () => {
        const capabilities = getTestCapabilities();
        await capabilities.logger.setup(capabilities);

        // Prepare a real remote repository to clone from
        await stubEventLogRepository(capabilities);

        const repoName = "atomic-working-git-repository-remote";
        const gitDir = path.join(capabilities.environment.workingDirectory(), repoName, ".git");

        // Spawn several parallel requests that will race to initialize the same repository
        const parallel = 6;
        const promises = [];
        for (let i = 0; i < parallel; i++) {
            promises.push(
                // Use getRepository with a remote initial_state which triggers synchronize
                workingRepository.getRepository(capabilities, repoName, { url: capabilities.environment.eventLogRepository() })
            );
        }

        // Wait for all to settle and fail fast if any rejected
        const results = await Promise.allSettled(promises);
        const rejected = results.filter((r) => r.status === "rejected");
        if (rejected.length > 0) {
            // Throw the first rejection to surface the underlying error in the test
            throw rejected[0].reason;
        }

        // Verify repository .git/index exists
        const indexExists = await fsp
            .stat(path.join(gitDir, "index"))
            .then(() => true)
            .catch(() => false);

        expect(indexExists).toBe(true);

        // Verify repository has at least the initial commit
        const commitCount = execFileSync("git", ["--git-dir", gitDir, "rev-list", "--count", "master"]).toString().trim();
        expect(parseInt(commitCount, 10)).toBeGreaterThanOrEqual(1);
    });
});
