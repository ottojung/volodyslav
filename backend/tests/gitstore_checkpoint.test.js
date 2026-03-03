const fs = require("fs").promises;
const path = require("path");
const { execFileSync } = require("child_process");
const { checkpoint } = require("../src/gitstore");
const { transaction } = require("../src/gitstore");
const defaultBranch = require("../src/gitstore/default_branch");
const workingRepository = require("../src/gitstore/working_repository");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubEventLogRepository, stubDatetime, stubLogger } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    stubLogger(capabilities);
    return capabilities;
}

/**
 * Reads the latest commit message from a bare or non-bare git directory.
 */
function latestCommitMessage(gitDir) {
    return execFileSync("git", [
        "--git-dir", gitDir,
        "log", "-1", "--format=%s",
    ]).toString().trim();
}

/**
 * Reads the commit count on the default branch.
 */
function commitCount(gitDir) {
    return parseInt(
        execFileSync("git", [
            "--git-dir", gitDir,
            "rev-list", "--count", defaultBranch,
        ]).toString().trim(),
        10
    );
}

/**
 * Reads the content of a file from the latest commit.
 */
function fileContentAtHead(gitDir, filename) {
    return execFileSync("git", [
        "--git-dir", gitDir,
        "cat-file", "-p",
        `${defaultBranch}:${filename}`,
    ]).toString();
}

describe("gitstore checkpoint", () => {
    // ── Basic commit behaviour ──────────────────────────────────────────────

    test("checkpoint commits changes to the local working repository", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // First get (or create) the local working copy
        const gitDir = await workingRepository.getRepository(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() }
        );
        const workDir = path.dirname(gitDir);

        // Write a new file directly into the working copy
        await fs.writeFile(path.join(workDir, "checkpoint-test.txt"), "checkpoint content");

        await checkpoint(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() },
            "my checkpoint"
        );

        // Verify the file was committed
        const content = fileContentAtHead(gitDir, "checkpoint-test.txt");
        expect(content).toBe("checkpoint content");
    });

    test("checkpoint records the provided commit message", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const gitDir = await workingRepository.getRepository(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() }
        );
        const workDir = path.dirname(gitDir);

        await fs.writeFile(path.join(workDir, "msg-test.txt"), "data");

        await checkpoint(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() },
            "snapshot: evening backup"
        );

        expect(latestCommitMessage(gitDir)).toBe("snapshot: evening backup");
    });

    test("multiple checkpoints produce multiple commits", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const gitDir = await workingRepository.getRepository(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() }
        );
        const workDir = path.dirname(gitDir);
        const initialCount = commitCount(gitDir);

        await fs.writeFile(path.join(workDir, "a.txt"), "first");
        await checkpoint(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() },
            "first"
        );

        await fs.writeFile(path.join(workDir, "b.txt"), "second");
        await checkpoint(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() },
            "second"
        );

        expect(commitCount(gitDir)).toBe(initialCount + 2);
        expect(latestCommitMessage(gitDir)).toBe("second");
    });

    test("checkpoint stages untracked new files", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const gitDir = await workingRepository.getRepository(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() }
        );
        const workDir = path.dirname(gitDir);

        await fs.writeFile(path.join(workDir, "brand-new.txt"), "brand new file");

        await checkpoint(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() },
            "add brand new file"
        );

        const content = fileContentAtHead(gitDir, "brand-new.txt");
        expect(content).toBe("brand new file");
    });

    test("checkpoint stages modifications to tracked files", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const gitDir = await workingRepository.getRepository(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() }
        );
        const workDir = path.dirname(gitDir);

        // test.txt already exists from the stub; overwrite it
        await fs.writeFile(path.join(workDir, "test.txt"), "modified by checkpoint");

        await checkpoint(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() },
            "modify tracked file"
        );

        const content = fileContentAtHead(gitDir, "test.txt");
        expect(content).toBe("modified by checkpoint");
    });

    // ── Clean working tree ──────────────────────────────────────────────────

    test("checkpoint creates a commit even when the working tree is already clean", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const gitDir = await workingRepository.getRepository(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() }
        );
        const before = commitCount(gitDir);

        // No file changes – working tree is clean
        await checkpoint(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() },
            "empty checkpoint"
        );

        // --allow-empty always produces a new commit
        expect(commitCount(gitDir)).toBe(before + 1);
        expect(latestCommitMessage(gitDir)).toBe("empty checkpoint");
    });

    // ── "empty" initial_state ───────────────────────────────────────────────

    test("checkpoint works with 'empty' initial_state, initialising a local repo", async () => {
        const capabilities = getTestCapabilities();

        // No remote needed – the repo is created locally from scratch
        const gitDir = path.join(
            capabilities.environment.workingDirectory(),
            "local-only-repo", ".git"
        );

        await fs.writeFile(
            path.join(capabilities.environment.workingDirectory(), "local-only-repo", "state.txt"),
            "hello"
        ).catch(() => {
            // directory may not exist yet – that's fine, checkpoint will create it
        });

        // checkpoint with "empty" should initialise + commit
        await workingRepository.getRepository(capabilities, "local-only-repo", "empty");

        const workDir = path.dirname(gitDir);
        await fs.writeFile(path.join(workDir, "state.txt"), "local snapshot");

        await checkpoint(capabilities, "local-only-repo", "empty", "local checkpoint");

        const content = fileContentAtHead(gitDir, "state.txt");
        expect(content).toBe("local snapshot");
    });

    test("checkpoint creates a commit even on a clean 'empty' repo", async () => {
        const capabilities = getTestCapabilities();

        // Initialise the empty repo but add no extra files
        const gitDir = path.join(
            capabilities.environment.workingDirectory(),
            "local-only-repo2", ".git"
        );
        await workingRepository.getRepository(capabilities, "local-only-repo2", "empty");
        const before = commitCount(gitDir);

        // No new files – working tree is clean, but --allow-empty still commits
        await checkpoint(capabilities, "local-only-repo2", "empty", "empty repo checkpoint");

        expect(commitCount(gitDir)).toBe(before + 1);
        expect(latestCommitMessage(gitDir)).toBe("empty repo checkpoint");
    });

    // ── Mutex (serialisation) ───────────────────────────────────────────────

    test("concurrent checkpoints on the same path are serialised", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const gitDir = await workingRepository.getRepository(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() }
        );
        const workDir = path.dirname(gitDir);

        const order = [];
        const initialCount = commitCount(gitDir);

        // Fire two checkpoints in parallel.
        // Because --allow-empty is used, both calls always create a commit,
        // even if the first one already staged all the pending file changes.
        const p1 = (async () => {
            await fs.writeFile(path.join(workDir, "concurrent-a.txt"), "from a");
            await checkpoint(
                capabilities, "working-git-repository",
                { url: capabilities.environment.eventLogRepository() },
                "checkpoint A"
            );
            order.push("A");
        })();

        const p2 = (async () => {
            await fs.writeFile(path.join(workDir, "concurrent-b.txt"), "from b");
            await checkpoint(
                capabilities, "working-git-repository",
                { url: capabilities.environment.eventLogRepository() },
                "checkpoint B"
            );
            order.push("B");
        })();

        await Promise.all([p1, p2]);

        // Both futures must settle (no unhandled rejection / deadlock).
        expect(order).toHaveLength(2);
        expect(order).toContain("A");
        expect(order).toContain("B");

        // Two checkpoints → two new commits (--allow-empty guarantees this).
        expect(commitCount(gitDir)).toBe(initialCount + 2);
    });

    // ── No temporary work tree ──────────────────────────────────────────────

    test("checkpoint does not create extra directories inside the working copy", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const gitDir = await workingRepository.getRepository(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() }
        );
        const workDir = path.dirname(gitDir);

        // Snapshot the directory BEFORE writing the new file.
        const beforeEntries = await fs.readdir(workDir);

        await fs.writeFile(path.join(workDir, "direct.txt"), "direct write");

        await checkpoint(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() },
            "no extra dirs"
        );

        const afterEntries = await fs.readdir(workDir);

        // Only the file we wrote should be new; no temp subdirectory was created
        const newEntries = afterEntries.filter(e => !beforeEntries.includes(e));
        expect(newEntries).toEqual(["direct.txt"]);
    });

    // ── Interop with transaction ────────────────────────────────────────────

    test("checkpoint commits whatever is currently in the work tree", async () => {
        // Checkpoint is a direct "git add --all && git commit" on the local
        // working copy's work tree.  It commits what is physically present in
        // that directory – nothing more.  Files that were committed only via a
        // transaction (which clones into a temp tree and pushes back) are NOT
        // in the work tree of the local working copy and therefore are NOT
        // included in a subsequent checkpoint commit.
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // Initialise the working copy.
        const gitDir = await workingRepository.getRepository(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() }
        );
        const workDir = path.dirname(gitDir);

        // Write directly into the work tree and commit via checkpoint.
        await fs.writeFile(path.join(workDir, "cp-file.txt"), "from checkpoint");

        await checkpoint(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() },
            "checkpoint commit"
        );

        expect(latestCommitMessage(gitDir)).toBe("checkpoint commit");
        const cpContent = fileContentAtHead(gitDir, "cp-file.txt");
        expect(cpContent).toBe("from checkpoint");
    });

    test("transaction written after a checkpoint sees the checkpoint's changes", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // Checkpoint: write a baseline file into the working copy
        const gitDir = await workingRepository.getRepository(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() }
        );
        const workDir = path.dirname(gitDir);

        await fs.writeFile(path.join(workDir, "baseline.txt"), "baseline");
        await checkpoint(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() },
            "baseline checkpoint"
        );

        // Transaction: the temp work tree should include the checkpointed file
        await transaction(
            capabilities, "working-git-repository",
            { url: capabilities.environment.eventLogRepository() },
            async (store) => {
                const workTree = await store.getWorkTree();
                const baselineContent = await fs.readFile(
                    path.join(workTree, "baseline.txt"),
                    "utf8"
                );
                expect(baselineContent).toBe("baseline");

                await fs.writeFile(path.join(workTree, "baseline.txt"), "updated by tx");
                await store.commit("update baseline");
            }
        );

        const finalContent = fileContentAtHead(gitDir, "baseline.txt");
        expect(finalContent).toBe("updated by tx");
    });
});
