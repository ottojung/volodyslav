const fs = require("fs").promises;
const path = require("path");
const { execFileSync } = require("child_process");
const { transaction, checkpoint } = require("../src/gitstore");
const gitstoreModule = require("../src/gitstore");
const defaultBranch = require("../src/gitstore/default_branch");
const workingRepository = require("../src/gitstore/working_repository");
const { commit, fetchAndReconcile } = require("../src/gitstore/wrappers");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubEventLogRepository, stubDatetime, stubLogger } = require("./stubs");
jest.setTimeout(30000);


function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    stubLogger(capabilities);
    return capabilities;
}

describe("gitstore", () => {
    test("transaction allows reading and writing files", async () => {
        const capabilities = getTestCapabilities();
        const branch = defaultBranch(capabilities);
        await stubEventLogRepository(capabilities);
        await transaction(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() }, async (store) => {
            const workTree = await store.getWorkTree();
            const testFile = path.join(workTree, "test.txt");

            // Verify initial content
            const content = await fs.readFile(testFile, "utf8");
            expect(content).toBe("initial content");

            // Modify the file
            await fs.writeFile(testFile, "modified content");
            await store.commit("Test modification");
        });

        // Verify the changes were committed by reading directly from the repo
        const gitDir = await workingRepository.getRepository(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() });
        const output = execFileSync("git", [
            "--git-dir",
            gitDir,
            "cat-file",
            "-p",
            `${branch}:test.txt`,
        ]);
        expect(output.toString().trim()).toBe("modified content");
    });

    test("transaction allows multiple commits", async () => {
        const capabilities = getTestCapabilities();
        const branch = defaultBranch(capabilities);
        await stubEventLogRepository(capabilities);
        await transaction(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() }, async (store) => {
            const workTree = await store.getWorkTree();
            const testFile = path.join(workTree, "test.txt");

            // First modification
            await fs.writeFile(testFile, "first modification");
            await store.commit("First modification");

            // Second modification
            await fs.writeFile(testFile, "second modification");
            await store.commit("Second modification");
        });

        // Verify the changes were committed by reading directly from the repo
        const gitDir = await workingRepository.getRepository(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() });
        const commitCount = execFileSync("git", [
            "--git-dir",
            gitDir,
            "rev-list",
            "--count",
            branch,
        ]);
        expect(parseInt(commitCount)).toBe(3); // Initial + 2 modifications

        // Verify the final content
        const output = execFileSync("git", [
            "--git-dir",
            gitDir,
            "cat-file",
            "-p",
            `${branch}:test.txt`,
        ]);
        expect(output.toString().trim()).toBe("second modification");
    });

    test("transaction cleans up temporary work tree", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);
        let temporaryWorkTree;

        await expect(
            transaction(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() }, async (store) => {
                temporaryWorkTree = await store.getWorkTree(); // Get the work tree to create it
                await expect(
                    fs.access(temporaryWorkTree)
                ).resolves.toBeUndefined();
            })
        ).resolves.toBeUndefined();

        // Verify that no temporary directories are left behind
        await expect(fs.access(temporaryWorkTree)).rejects.toThrow(
            "ENOENT: no such file or directory"
        );
    });

    test("transaction cleans up temporary work tree even if transformation fails", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);
        let temporaryWorkTree;

        await expect(
            transaction(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() }, async (store) => {
                temporaryWorkTree = await store.getWorkTree(); // Get the work tree to create it
                await expect(
                    fs.access(temporaryWorkTree)
                ).resolves.toBeUndefined();
                throw new Error("Test error");
            })
        ).rejects.toThrow("Test error");

        // Verify that no temporary directories are left behind
        await expect(fs.access(temporaryWorkTree)).rejects.toThrow(
            "ENOENT: no such file or directory"
        );
    });

    /**
     * Count the number of commits in a git directory.
     * @param {string} gitDir
     * @returns {number}
     */
    function commitCount(gitDir) {
        const output = execFileSync("git", [
            "--git-dir", gitDir,
            "rev-list", "--count", "HEAD",
        ]).toString().trim();
        return Number(output);
    }

    test("checkpoint does not create extra commit when files unchanged, even with many files", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);
        await stubDatetime(capabilities);
        const gitDir = await workingRepository.getRepository(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() }
        );
        const workDir = path.dirname(gitDir);

        // Create many files
        for (let i = 0; i < 100; i++) {
            await fs.writeFile(path.join(workDir, `file-${i}.txt`), `content-${i}`);
        }
        await checkpoint(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() }, "Add 100 files");
        const afterAdd = commitCount(gitDir);
        expect(afterAdd).toBeGreaterThanOrEqual(2);

        // Second checkpoint with no changes: must not create extra commit
        await checkpoint(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() }, "No-op");
        expect(commitCount(gitDir)).toBe(afterAdd);
    });

    test("listRemoteBranches uses narrowed pattern", async () => {
        const capabilities = getTestCapabilities();
        const branch = defaultBranch(capabilities);
        const workDir = path.join(capabilities.environment.workingDirectory(), "test-narrow");
        await fs.mkdir(workDir, { recursive: true });
        await capabilities.git.call("init", "--quiet", "--initial-branch", branch, workDir);
        // Create a bare remote and push a hostname-style branch and a non-hostname branch
        const remoteDir = path.join(capabilities.environment.workingDirectory(), "test-remote.git");
        await capabilities.git.call("init", "--bare", "--quiet", remoteDir);
        await capabilities.git.call("-C", workDir, "remote", "add", "origin", remoteDir);
        await fs.writeFile(path.join(workDir, "test.txt"), "content");
        await capabilities.git.call("-C", workDir, "add", "--all");
        await capabilities.git.call("-C", workDir, "-c", "user.name=test", "-c", "user.email=test", "commit", "--quiet", "--message", "init");
        await capabilities.git.call("-C", workDir, "push", "--quiet", "-u", "origin", branch);
        await capabilities.git.call("-C", workDir, "checkout", "--quiet", "-b", "alice-main");
        await fs.writeFile(path.join(workDir, "alice.txt"), "alice");
        await capabilities.git.call("-C", workDir, "add", "--all");
        await capabilities.git.call("-C", workDir, "-c", "user.name=test", "-c", "user.email=test", "commit", "--quiet", "--message", "alice");
        await capabilities.git.call("-C", workDir, "push", "--quiet", "-u", "origin", "alice-main");
        await capabilities.git.call("-C", workDir, "checkout", "--quiet", "-b", "bob-main", "alice-main");
        await capabilities.git.call("-C", workDir, "push", "--quiet", "-u", "origin", "bob-main");
        // A non-hostname branch that should be excluded
        await capabilities.git.call("-C", workDir, "checkout", "--quiet", "-b", "other-branch", "alice-main");
        await capabilities.git.call("-C", workDir, "push", "--quiet", "-u", "origin", "other-branch");

        const branches = await gitstoreModule.mergeHostBranches.listRemoteBranches(capabilities, workDir);
        expect(branches).toContain("origin/alice-main");
        expect(branches).toContain("origin/bob-main");
        expect(branches).not.toContain("origin/other-branch");
    });

    test("commit propagates git diff failure when exit code is not 1", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // Set up a real repo so git add --all succeeds
        const repoGitDir = await workingRepository.getRepository(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() }
        );

        // Spy on git.call: let all calls through except diff --exit-code
        const originalCall = capabilities.git.call;
        capabilities.git.call = jest.fn((...args) => {
            if (args.some(a => typeof a === 'string' && a === 'diff')) {
                const error = new Error('git diff failed');
                error.code = 128;
                throw error;
            }
            return originalCall(...args);
        });

        await expect(commit(
            capabilities,
            repoGitDir,
            path.dirname(repoGitDir),
            "should fail"
        )).rejects.toThrow();

        // Restore prototype method so subsequent tests see the original
        delete capabilities.git.call;
    });

    test("fetchAndReconcile creates merge-like commit when remote diverges", async () => {
        const capabilities = getTestCapabilities();
        const branch = defaultBranch(capabilities);
        const workDir = path.join(capabilities.environment.workingDirectory(), "test-fetch-reconcile");
        await fs.mkdir(workDir, { recursive: true });

        // Create a bare remote
        const remoteDir = path.join(capabilities.environment.workingDirectory(), "test-fetch-remote.git");
        await capabilities.git.call("init", "--bare", "--quiet", remoteDir);

        // Init local repo, make initial commit, push to remote
        await capabilities.git.call("init", "--quiet", "--initial-branch", branch, workDir);
        await fs.writeFile(path.join(workDir, "initial.txt"), "initial");
        await capabilities.git.call("-C", workDir, "add", "--all");
        await capabilities.git.call("-C", workDir, "-c", "user.name=test", "-c", "user.email=test", "commit", "--quiet", "--message", "initial");
        await capabilities.git.call("-C", workDir, "remote", "add", "origin", remoteDir);
        await capabilities.git.call("-C", workDir, "push", "--quiet", "-u", "origin", branch);

        // Push a new commit to the remote that the local doesn't have yet
        await fs.writeFile(path.join(workDir, "remote-change.txt"), "remote");
        await capabilities.git.call("-C", workDir, "add", "--all");
        await capabilities.git.call("-C", workDir, "-c", "user.name=test", "-c", "user.email=test", "commit", "--quiet", "--message", "remote-change");
        await capabilities.git.call("-C", workDir, "push", "--quiet", "origin", branch);

        // Reset local back to the first commit so local is behind remote
        await capabilities.git.call("-C", workDir, "reset", "--quiet", "--hard", "HEAD~1");

        const before = await capabilities.git
            .call("-C", workDir, "rev-list", "--count", branch)
            .then(r => Number(r.stdout.trim()));
        await fetchAndReconcile(capabilities, workDir, undefined);
        const after = await capabilities.git
            .call("-C", workDir, "rev-list", "--count", branch)
            .then(r => Number(r.stdout.trim()));

        // The fetchAndReconcile should have created a merge-like commit
        expect(after).toBeGreaterThan(before);
    });

    test("fetchAndReconcile does not create commit when tree is unchanged", async () => {
        const capabilities = getTestCapabilities();
        const branch = defaultBranch(capabilities);
        const workDir = path.join(capabilities.environment.workingDirectory(), "test-fetch-reconcile-noop");
        await fs.mkdir(workDir, { recursive: true });

        const remoteDir = path.join(capabilities.environment.workingDirectory(), "test-fetch-remote-noop.git");
        await capabilities.git.call("init", "--bare", "--quiet", remoteDir);

        await capabilities.git.call("init", "--quiet", "--initial-branch", branch, workDir);
        await fs.writeFile(path.join(workDir, "initial.txt"), "initial");
        await capabilities.git.call("-C", workDir, "add", "--all");
        await capabilities.git.call("-C", workDir, "-c", "user.name=test", "-c", "user.email=test", "commit", "--quiet", "--message", "initial");
        await capabilities.git.call("-C", workDir, "remote", "add", "origin", remoteDir);
        await capabilities.git.call("-C", workDir, "push", "--quiet", "-u", "origin", branch);

        // Commit more to remote
        await fs.writeFile(path.join(workDir, "extra.txt"), "extra");
        await capabilities.git.call("-C", workDir, "add", "--all");
        await capabilities.git.call("-C", workDir, "-c", "user.name=test", "-c", "user.email=test", "commit", "--quiet", "--message", "extra");
        await capabilities.git.call("-C", workDir, "push", "--quiet", "origin", branch);

        // Reset local back
        await capabilities.git.call("-C", workDir, "reset", "--quiet", "--hard", "HEAD~1");
        // First call creates the merge-like reset commit
        await fetchAndReconcile(capabilities, workDir, undefined);

        const before = await capabilities.git
            .call("-C", workDir, "rev-list", "--count", branch)
            .then(r => Number(r.stdout.trim()));
        // Second call with no divergence should be a no-op
        await fetchAndReconcile(capabilities, workDir, undefined);
        const after = await capabilities.git
            .call("-C", workDir, "rev-list", "--count", branch)
            .then(r => Number(r.stdout.trim()));

        expect(after).toBe(before);
    });
});
