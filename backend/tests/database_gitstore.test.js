/**
 * Integration tests for database/gitstore.js — the gitstore wrapper that
 * checkpoints the incremental-graph RootDatabase.
 *
 * These tests exercise the real git layer (no mocking of git itself) so they
 * require a working `git` binary on PATH and will create temporary directories.
 */

const fs = require("fs").promises;
const path = require("path");
const { execFileSync } = require("child_process");
const {
    checkpointDatabase,
    runMigrationInTransaction,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
    getRootDatabase,
    keyToRelativePath,
} = require("../src/generators/incremental_graph/database");
const defaultBranch = require("../src/gitstore/default_branch");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubDatetime, stubLogger } = require("./stubs");
jest.setTimeout(30000);


// ── Test capability factory ───────────────────────────────────────────────────

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    stubLogger(capabilities);
    return capabilities;
}

// ── Git inspection helpers ────────────────────────────────────────────────────

/**
 * Absolute path to the `.git` directory for the checkpoint repository.
 * @param {object} capabilities
 * @returns {string}
 */
function checkpointGitDir(capabilities) {
    return path.join(
        capabilities.environment.workingDirectory(),
        CHECKPOINT_WORKING_PATH,
        ".git"
    );
}

/**
 * Number of commits on the default branch inside the checkpoint repository.
 * @param {string} gitDir
 * @returns {number}
 */
function commitCount(capabilities, gitDir) {
    return parseInt(
        execFileSync("git", [
            "--git-dir", gitDir,
            "rev-list", "--count", defaultBranch(capabilities),
        ]).toString().trim(),
        10
    );
}

/**
 * Subject line of the most recent commit.
 * @param {string} gitDir
 * @returns {string}
 */
function latestCommitMessage(gitDir) {
    return execFileSync("git", [
        "--git-dir", gitDir,
        "log", "-1", "--format=%s",
    ]).toString().trim();
}

/**
 * Subject lines of the most recent commits, newest first.
 * @param {string} gitDir
 * @param {number} count
 * @returns {string[]}
 */
function latestCommitMessages(gitDir, count) {
    return execFileSync("git", [
        "--git-dir", gitDir,
        "log", `-n${count}`, "--format=%s",
    ]).toString().trim().split("\n").filter(Boolean);
}

/**
 * Top-level entry names of the current HEAD tree (non-recursive).
 * @param {string} gitDir
 * @returns {string[]}
 */
function topLevelEntries(capabilities, gitDir) {
    return execFileSync("git", [
        "--git-dir", gitDir,
        "ls-tree", "--name-only", defaultBranch(capabilities),
    ]).toString().trim().split("\n").filter(Boolean);
}

/**
 * All file paths tracked in the current HEAD commit (recursive).
 * @param {string} gitDir
 * @returns {string[]}
 */
function allTrackedFiles(capabilities, gitDir) {
    return execFileSync("git", [
        "--git-dir", gitDir,
        "ls-tree", "-r", "--name-only", defaultBranch(capabilities),
    ]).toString().trim().split("\n").filter(Boolean);
}

/**
 * Content of a file as it was recorded in the latest commit.
 * @param {string} gitDir
 * @param {string} filePath - path relative to the working tree root
 * @returns {string}
 */
function fileContentAtHead(capabilities, gitDir, filePath) {
    return execFileSync("git", [
        "--git-dir", gitDir,
        "cat-file", "-p",
        `${defaultBranch(capabilities)}:${filePath}`,
    ]).toString();
}

// ── Helpers to seed the live database ────────────────────────────────────────

/**
 * Seed raw entries into the live incremental-graph database.
 * @param {object} capabilities
 * @param {Array<[string, *]>} entries
 * @returns {Promise<import('../src/generators/incremental_graph/database/root_database').RootDatabase>}
 */
async function seedDatabase(capabilities, entries) {
    const db = await getRootDatabase(capabilities);
    for (const [key, value] of entries) {
        await db._rawPut(key, value);
    }
    return db;
}

/**
 * Converts a raw root-LevelDB key (e.g. `!x!!values!!event%2Fone`) to the
 * rendered snapshot path (e.g. `r/values/event/one`).
 * `keyToRelativePath` first maps the raw key to `x/...` or `y/...`, then this
 * helper rewrites the replica prefix to the stable `r/` alias.
 * @param {string} key - raw root-LevelDB key
 * @returns {string}
 */
function renderedKeyPath(key) {
    return keyToRelativePath(key).replace(/^[xy]\//, 'r/');
}


describe("checkpointDatabase", () => {

    // ── Basic commit behaviour ────────────────────────────────────────────────

    test("creates a commit when called for the first time", async () => {
        const capabilities = getTestCapabilities();
        const db = await seedDatabase(capabilities, [["!_meta!format", "xy-v1"]]);
        try {
            await checkpointDatabase(capabilities, "initial checkpoint", db);

            const gitDir = checkpointGitDir(capabilities);
            // +1 for the "Initial empty commit" created by getRepository on first use
            expect(commitCount(capabilities, gitDir)).toBe(2);
        } finally {
            await db.close();
        }
    });

    test("commit message matches the provided message", async () => {
        const capabilities = getTestCapabilities();
        const db = await seedDatabase(capabilities, [["!_meta!format", "xy-v1"]]);
        try {
            await checkpointDatabase(capabilities, "my checkpoint message", db);

            const gitDir = checkpointGitDir(capabilities);
            expect(latestCommitMessage(gitDir)).toBe("my checkpoint message");
        } finally {
            await db.close();
        }
    });

    test("creates a new commit on every call", async () => {
        const capabilities = getTestCapabilities();
        const db = await seedDatabase(capabilities, [
            ["!_meta!format", "xy-v1"],
            ['!x!!values!{"head":"event","args":["same"]}', { version: 1 }],
        ]);
        try {
            await checkpointDatabase(capabilities, "first", db);
            await db._rawPut('!x!!values!{"head":"event","args":["same"]}', { version: 2 });
            await checkpointDatabase(capabilities, "second", db);

            const gitDir = checkpointGitDir(capabilities);
            // +1 for the "Initial empty commit" created by getRepository on first use
            expect(commitCount(capabilities, gitDir)).toBe(3);
        } finally {
            await db.close();
        }
    });

    test("commit messages are recorded in order", async () => {
        const capabilities = getTestCapabilities();
        const db = await seedDatabase(capabilities, [
            ["!_meta!format", "xy-v1"],
            ['!x!!values!{"head":"event","args":["ordered"]}', { version: "a" }],
        ]);
        try {
            await checkpointDatabase(capabilities, "checkpoint-alpha", db);
            await db._rawPut('!x!!values!{"head":"event","args":["ordered"]}', { version: "b" });
            await checkpointDatabase(capabilities, "checkpoint-beta", db);

            const gitDir = checkpointGitDir(capabilities);
            // Most recent commit is beta
            expect(latestCommitMessage(gitDir)).toBe("checkpoint-beta");
            // +1 for the "Initial empty commit" created by getRepository on first use
            expect(commitCount(capabilities, gitDir)).toBe(3);
        } finally {
            await db.close();
        }
    });

    // ── allow-empty ───────────────────────────────────────────────────────────

    test("does not commit when no files have changed", async () => {
        const capabilities = getTestCapabilities();
        const db = await seedDatabase(capabilities, [["!_meta!format", "xy-v1"]]);
        try {
            await checkpointDatabase(capabilities, "first", db);
            const gitDir = checkpointGitDir(capabilities);
            const countAfterFirst = commitCount(capabilities, gitDir);

            await checkpointDatabase(capabilities, "second – no change", db);

            expect(commitCount(capabilities, gitDir)).toBe(countAfterFirst);
        } finally {
            await db.close();
        }
    });

    test("can be called before any database files have been written", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            await checkpointDatabase(capabilities, "empty repo checkpoint", db);

            const gitDir = checkpointGitDir(capabilities);
            expect(commitCount(capabilities, gitDir)).toBe(2);
            expect(topLevelEntries(capabilities, gitDir)).toEqual([DATABASE_SUBPATH]);
            expect(allTrackedFiles(capabilities, gitDir)).toEqual([
                `${DATABASE_SUBPATH}/_meta/current_replica`,
                `${DATABASE_SUBPATH}/_meta/format`,
            ]);
        } finally {
            await db.close();
        }
    });

    // ── Repository layout ─────────────────────────────────────────────────────

    test("database subdirectory is the only top-level entry in the repository", async () => {
        const capabilities = getTestCapabilities();
        const db = await seedDatabase(capabilities, [
            ["!_meta!format", "xy-v1"],
            ['!x!!values!{"head":"event","args":["layout"]}', { ok: true }],
        ]);
        try {
            await checkpointDatabase(capabilities, "layout check", db);

            const gitDir = checkpointGitDir(capabilities);
            expect(topLevelEntries(capabilities, gitDir)).toEqual([DATABASE_SUBPATH]);
        } finally {
            await db.close();
        }
    });

    test("rendered database files are tracked inside DATABASE_SUBPATH in the commit tree", async () => {
        const capabilities = getTestCapabilities();
        const db = await seedDatabase(capabilities, [
            ["!_meta!format", "xy-v1"],
            ['!x!!values!{"head":"event","args":["one"]}', { name: "first" }],
            ['!x!!meta!version', "1.2.3"],
        ]);
        try {
            await checkpointDatabase(capabilities, "track files", db);

            const gitDir = checkpointGitDir(capabilities);
            const tracked = allTrackedFiles(capabilities, gitDir);
            expect(tracked).toContain(`${DATABASE_SUBPATH}/_meta/format`);
            expect(tracked).toContain(
                `${DATABASE_SUBPATH}/${renderedKeyPath('!x!!values!{"head":"event","args":["one"]}')}`
            );
            expect(tracked).toContain(`${DATABASE_SUBPATH}/r/meta/version`);
        } finally {
            await db.close();
        }
    });

    test("file content is correctly recorded in the commit", async () => {
        const capabilities = getTestCapabilities();
        const db = await seedDatabase(capabilities, [
            ['!x!!values!{"head":"event","args":["hello"]}', { message: "hello-content" }],
        ]);
        try {
            await checkpointDatabase(capabilities, "content check", db);

            const gitDir = checkpointGitDir(capabilities);
            expect(
                fileContentAtHead(
                    capabilities,
                    gitDir,
                    `${DATABASE_SUBPATH}/${renderedKeyPath('!x!!values!{"head":"event","args":["hello"]}')}`
                )
            ).toBe(JSON.stringify({ message: "hello-content" }, null, 2));
        } finally {
            await db.close();
        }
    });

    test("git repository is located inside CHECKPOINT_WORKING_PATH", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            await checkpointDatabase(capabilities, "location check", db);

            const gitDir = checkpointGitDir(capabilities);
            const stat = await fs.stat(gitDir);
            expect(stat.isDirectory()).toBe(true);
            const liveDbStat = await fs.stat(
                path.join(capabilities.environment.workingDirectory(), LIVE_DATABASE_WORKING_PATH)
            );
            expect(liveDbStat.isDirectory()).toBe(true);
        } finally {
            await db.close();
        }
    });

    // ── History preservation ──────────────────────────────────────────────────

    test("files written in earlier calls remain in git history", async () => {
        const capabilities = getTestCapabilities();
        const oldKey = '!x!!values!{"head":"event","args":["old"]}';
        const newKey = '!x!!values!{"head":"event","args":["new"]}';
        const db = await seedDatabase(capabilities, [[oldKey, { value: "old content" }]]);
        try {
            await checkpointDatabase(capabilities, "first", db);
            await db._rawPut(newKey, { value: "new content" });
            await checkpointDatabase(capabilities, "second", db);

            const gitDir = checkpointGitDir(capabilities);
            const tracked = allTrackedFiles(capabilities, gitDir);
            expect(tracked).toContain(`${DATABASE_SUBPATH}/${renderedKeyPath(oldKey)}`);
            expect(tracked).toContain(`${DATABASE_SUBPATH}/${renderedKeyPath(newKey)}`);
        } finally {
            await db.close();
        }
    });

    test("updated file content is reflected in the latest commit", async () => {
        const capabilities = getTestCapabilities();
        const key = '!x!!values!{"head":"event","args":["db"]}';
        const db = await seedDatabase(capabilities, [[key, { version: "version-1" }]]);
        try {
            await checkpointDatabase(capabilities, "v1", db);
            await db._rawPut(key, { version: "version-2" });
            await checkpointDatabase(capabilities, "v2", db);

            const gitDir = checkpointGitDir(capabilities);
            expect(
                fileContentAtHead(capabilities, gitDir, `${DATABASE_SUBPATH}/${renderedKeyPath(key)}`)
            ).toBe(JSON.stringify({ version: "version-2" }, null, 2));
        } finally {
            await db.close();
        }
    });

    // ── Concurrency ───────────────────────────────────────────────────────────

    test("concurrent calls are serialized: all changes are committed", async () => {
        const capabilities = getTestCapabilities();
        const key = '!x!!values!{"head":"event","args":["base"]}';
        const db = await seedDatabase(capabilities, [[key, { value: "base" }]]);
        try {
            await Promise.all([
                checkpointDatabase(capabilities, "concurrent-1", db),
                checkpointDatabase(capabilities, "concurrent-2", db),
            ]);

            const gitDir = checkpointGitDir(capabilities);
            expect(commitCount(capabilities, gitDir)).toBeGreaterThanOrEqual(2);
            expect(
                fileContentAtHead(capabilities, gitDir, `${DATABASE_SUBPATH}/${renderedKeyPath(key)}`)
            ).toBe(JSON.stringify({ value: "base" }, null, 2));
        } finally {
            await db.close();
        }
    });
});

describe("runMigrationInTransaction", () => {
    test("records pre-migration and post-migration commits inside one transaction", async () => {
        const capabilities = getTestCapabilities();
        const key = '!x!!values!{"head":"event","args":["migration"]}';
        const db = await seedDatabase(capabilities, [[key, { version: "before" }]]);
        try {
            const result = await runMigrationInTransaction(
                capabilities,
                db,
                "pre-migration: 1 → 2",
                "post-migration: 2",
                async () => {
                    await db._rawPut(key, { version: "after" });
                    return "done";
                }
            );

            expect(result).toBe("done");
            const gitDir = checkpointGitDir(capabilities);
            expect(commitCount(capabilities, gitDir)).toBe(3);
            expect(latestCommitMessages(gitDir, 2)).toEqual([
                "post-migration: 2",
                "pre-migration: 1 → 2",
            ]);
            expect(
                fileContentAtHead(capabilities, gitDir, `${DATABASE_SUBPATH}/${renderedKeyPath(key)}`)
            ).toBe(JSON.stringify({ version: "after" }, null, 2));
        } finally {
            await db.close();
        }
    });

    test("does not persist pre-migration commit if the migration callback fails", async () => {
        const capabilities = getTestCapabilities();
        const key = '!x!!values!{"head":"event","args":["migration-fail"]}';
        const db = await seedDatabase(capabilities, [[key, { version: "before" }]]);
        try {
            await expect(
                runMigrationInTransaction(
                    capabilities,
                    db,
                    "pre-migration: fail",
                    "post-migration: fail",
                    async () => {
                        await db._rawPut(key, { version: "after" });
                        throw new Error("migration failure");
                    }
                )
            ).rejects.toThrow("migration failure");

            const gitDir = checkpointGitDir(capabilities);
            expect(commitCount(capabilities, gitDir)).toBe(1);
            expect(allTrackedFiles(capabilities, gitDir)).toEqual([]);
        } finally {
            await db.close();
        }
    });
});

describe("dirty-state recovery", () => {

    // ── Unborn branch ─────────────────────────────────────────────────────────

    test("checkpointDatabase recovers when git repo was initialised but has no commits (unborn branch)", async () => {
        const capabilities = getTestCapabilities();
        const workDir = path.join(
            capabilities.environment.workingDirectory(),
            CHECKPOINT_WORKING_PATH
        );

        // Simulate an interrupted initializeEmptyRepository: git init succeeded
        // but the initial commit was never made.
        await fs.mkdir(workDir, { recursive: true });
        execFileSync("git", [
            "-C", workDir, "init",
            `--initial-branch=${defaultBranch(capabilities)}`,
        ]);
        execFileSync("git", ["-C", workDir, "config", "receive.denyCurrentBranch", "ignore"]);
        // HEAD file now exists but points to an unborn branch — no commits yet.

        const db = await seedDatabase(capabilities, [["!_meta!format", "xy-v1"]]);
        try {
            // Should not throw even though there are no commits yet.
            await checkpointDatabase(capabilities, "checkpoint on unborn branch", db);

            const gitDir = checkpointGitDir(capabilities);
            expect(commitCount(capabilities, gitDir)).toBeGreaterThanOrEqual(1);
        } finally {
            await db.close();
        }
    });

    // ── MERGE_HEAD ────────────────────────────────────────────────────────────

    test("checkpointDatabase recovers when MERGE_HEAD is present from a prior interrupted merge", async () => {
        const capabilities = getTestCapabilities();
        const db = await seedDatabase(capabilities, [["!_meta!format", "xy-v1"]]);
        try {
            // Establish a clean baseline.
            await checkpointDatabase(capabilities, "baseline", db);
            const gitDir = checkpointGitDir(capabilities);
            const baselineCount = commitCount(capabilities, gitDir);

            // Simulate an interrupted merge by writing a MERGE_HEAD file.
            await fs.writeFile(
                path.join(gitDir, "MERGE_HEAD"),
                "0000000000000000000000000000000000000000\n"
            );

            // A subsequent checkpoint must succeed despite MERGE_HEAD being present.
            await checkpointDatabase(capabilities, "after merge head", db);

            // Verify the repository advanced normally.
            expect(commitCount(capabilities, gitDir)).toBeGreaterThanOrEqual(baselineCount);
        } finally {
            await db.close();
        }
    });

    test("runMigrationInTransaction recovers when MERGE_HEAD is present", async () => {
        const capabilities = getTestCapabilities();
        const key = '!x!!values!{"head":"event","args":["merge-head-recovery"]}';
        const db = await seedDatabase(capabilities, [[key, { v: 1 }]]);
        try {
            // Establish a clean baseline.
            await checkpointDatabase(capabilities, "baseline", db);
            const gitDir = checkpointGitDir(capabilities);

            // Simulate an interrupted merge.
            await fs.writeFile(
                path.join(gitDir, "MERGE_HEAD"),
                "0000000000000000000000000000000000000000\n"
            );

            // The migration must succeed despite the leftover merge state.
            const result = await runMigrationInTransaction(
                capabilities,
                db,
                "pre-migration",
                "post-migration",
                async () => {
                    await db._rawPut(key, { v: 2 });
                    return "ok";
                }
            );
            expect(result).toBe("ok");
            expect(
                fileContentAtHead(
                    capabilities,
                    gitDir,
                    `${DATABASE_SUBPATH}/${renderedKeyPath(key)}`
                )
            ).toBe(JSON.stringify({ v: 2 }, null, 2));
        } finally {
            await db.close();
        }
    });

    // ── CHERRY_PICK_HEAD ─────────────────────────────────────────────────────

    test("checkpointDatabase recovers when CHERRY_PICK_HEAD is present", async () => {
        const capabilities = getTestCapabilities();
        const db = await seedDatabase(capabilities, [["!_meta!format", "xy-v1"]]);
        try {
            await checkpointDatabase(capabilities, "baseline", db);
            const gitDir = checkpointGitDir(capabilities);

            // Simulate an interrupted cherry-pick.
            await fs.writeFile(
                path.join(gitDir, "CHERRY_PICK_HEAD"),
                "0000000000000000000000000000000000000000\n"
            );

            await checkpointDatabase(capabilities, "after cherry-pick head", db);

            // Verify CHERRY_PICK_HEAD has been cleaned up.
            const cherryPickHeadGone = await fs
                .stat(path.join(gitDir, "CHERRY_PICK_HEAD"))
                .then(() => false)
                .catch(() => true);
            expect(cherryPickHeadGone).toBe(true);
        } finally {
            await db.close();
        }
    });

    // ── Untracked stray files ─────────────────────────────────────────────────

    test("checkpointDatabase cleans up untracked stray files and directories from the working tree", async () => {
        const capabilities = getTestCapabilities();
        const db = await seedDatabase(capabilities, [["!_meta!format", "xy-v1"]]);
        try {
            await checkpointDatabase(capabilities, "baseline", db);

            // Drop untracked files/directories into the working tree to simulate
            // leftover artifacts from a previous interrupted operation.
            const workDir = path.join(
                capabilities.environment.workingDirectory(),
                CHECKPOINT_WORKING_PATH
            );
            await fs.mkdir(path.join(workDir, "stray-dir"), { recursive: true });
            await fs.writeFile(
                path.join(workDir, "stray-dir", "file.txt"),
                "stray content"
            );
            await fs.writeFile(path.join(workDir, "stray-file.txt"), "another stray file");

            // checkpointDatabase must succeed and stray content must be removed.
            await checkpointDatabase(capabilities, "after stray files", db);

            await expect(
                fs.stat(path.join(workDir, "stray-dir"))
            ).rejects.toThrow();
            await expect(
                fs.stat(path.join(workDir, "stray-file.txt"))
            ).rejects.toThrow();
        } finally {
            await db.close();
        }
    });

    // ── Staged (indexed) files ────────────────────────────────────────────────

    test("checkpointDatabase recovers when staged files are present without a commit", async () => {
        const capabilities = getTestCapabilities();
        const db = await seedDatabase(capabilities, [["!_meta!format", "xy-v1"]]);
        try {
            await checkpointDatabase(capabilities, "baseline", db);

            // Stage a file without committing to simulate a crash after `git add`.
            const workDir = path.join(
                capabilities.environment.workingDirectory(),
                CHECKPOINT_WORKING_PATH
            );
            await fs.writeFile(path.join(workDir, "staged.txt"), "staged content");
            execFileSync("git", ["-C", workDir, "add", "staged.txt"]);
            // Intentionally do NOT commit.

            // checkpointDatabase must succeed and the staged file must be gone.
            await checkpointDatabase(capabilities, "after staged file", db);

            await expect(
                fs.stat(path.join(workDir, "staged.txt"))
            ).rejects.toThrow();
        } finally {
            await db.close();
        }
    });

    // ── Rebase state ─────────────────────────────────────────────────────────

    test("checkpointDatabase recovers when a rebase-merge directory is present", async () => {
        const capabilities = getTestCapabilities();
        const db = await seedDatabase(capabilities, [["!_meta!format", "xy-v1"]]);
        try {
            await checkpointDatabase(capabilities, "baseline", db);
            const gitDir = checkpointGitDir(capabilities);
            const baselineCount = commitCount(capabilities, gitDir);

            // Simulate a rebase-in-progress by creating the rebase-merge directory
            // with the minimum file set that makes git recognise the state.
            const rebaseDir = path.join(gitDir, "rebase-merge");
            await fs.mkdir(rebaseDir, { recursive: true });
            const branch = defaultBranch(capabilities);
            await fs.writeFile(
                path.join(rebaseDir, "head-name"),
                `refs/heads/${branch}\n`
            );
            await fs.writeFile(
                path.join(rebaseDir, "onto"),
                "0000000000000000000000000000000000000000\n"
            );

            // checkpointDatabase must succeed despite the bogus rebase state.
            await checkpointDatabase(capabilities, "after rebase state", db);
            expect(commitCount(capabilities, gitDir)).toBeGreaterThanOrEqual(baselineCount);
        } finally {
            await db.close();
        }
    });

    // ── Database snapshot is correct after recovery ───────────────────────────

    test("database snapshot content is correct after dirty-state recovery", async () => {
        const capabilities = getTestCapabilities();
        const key = '!x!!values!{"head":"event","args":["content-check"]}';
        const db = await seedDatabase(capabilities, [
            [key, { value: "recorded-after-recovery" }],
        ]);
        try {
            await checkpointDatabase(capabilities, "baseline", db);
            const gitDir = checkpointGitDir(capabilities);

            // Introduce dirty state.
            await fs.writeFile(
                path.join(gitDir, "MERGE_HEAD"),
                "0000000000000000000000000000000000000000\n"
            );

            // Checkpoint after dirty state.
            await checkpointDatabase(capabilities, "snapshot after recovery", db);

            // Verify the snapshot content is correct and not corrupted.
            expect(
                fileContentAtHead(
                    capabilities,
                    gitDir,
                    `${DATABASE_SUBPATH}/${renderedKeyPath(key)}`
                )
            ).toBe(JSON.stringify({ value: "recorded-after-recovery" }, null, 2));
        } finally {
            await db.close();
        }
    });

    // ── Multiple checkpoints after recovery ───────────────────────────────────

    test("multiple checkpoints succeed after dirty-state recovery", async () => {
        const capabilities = getTestCapabilities();
        const db = await seedDatabase(capabilities, [["!_meta!format", "xy-v1"]]);
        try {
            await checkpointDatabase(capabilities, "baseline", db);
            const gitDir = checkpointGitDir(capabilities);

            // Introduce dirty state.
            await fs.writeFile(
                path.join(gitDir, "MERGE_HEAD"),
                "0000000000000000000000000000000000000000\n"
            );

            // First call cleans up and checkpoints.
            await checkpointDatabase(capabilities, "recovery checkpoint", db);

            // Subsequent checkpoints must also work normally.
            await db._rawPut('!x!!values!{"head":"event","args":["after-recovery"]}', { ok: true });
            await checkpointDatabase(capabilities, "after recovery 1", db);
            await checkpointDatabase(capabilities, "after recovery 2", db);

            expect(latestCommitMessage(gitDir)).toBe("after recovery 1");
        } finally {
            await db.close();
        }
    });
});
