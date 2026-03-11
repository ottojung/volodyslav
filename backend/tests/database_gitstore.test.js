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
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
    getRootDatabase,
    keyToRelativePath,
} = require("../src/generators/incremental_graph/database");
const defaultBranch = require("../src/gitstore/default_branch");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubDatetime, stubLogger } = require("./stubs");

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
 * Top-level entry names of the current HEAD tree (non-recursive).
 * @param {string} gitDir
 * @returns {string[]}
 */
function topLevelEntries(gitDir) {
    return execFileSync("git", [
        "--git-dir", gitDir,
        "ls-tree", "--name-only", defaultBranch,
    ]).toString().trim().split("\n").filter(Boolean);
}

/**
 * All file paths tracked in the current HEAD commit (recursive).
 * @param {string} gitDir
 * @returns {string[]}
 */
function allTrackedFiles(gitDir) {
    return execFileSync("git", [
        "--git-dir", gitDir,
        "ls-tree", "-r", "--name-only", defaultBranch,
    ]).toString().trim().split("\n").filter(Boolean);
}

/**
 * Content of a file as it was recorded in the latest commit.
 * @param {string} gitDir
 * @param {string} filePath - path relative to the working tree root
 * @returns {string}
 */
function fileContentAtHead(gitDir, filePath) {
    return execFileSync("git", [
        "--git-dir", gitDir,
        "cat-file", "-p",
        `${defaultBranch}:${filePath}`,
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkpointDatabase", () => {

    // ── Basic commit behaviour ────────────────────────────────────────────────

    test("creates a commit when called for the first time", async () => {
        const capabilities = getTestCapabilities();
        const db = await seedDatabase(capabilities, [["!_meta!format", "xy-v1"]]);
        try {
            await checkpointDatabase(capabilities, "initial checkpoint", db);

            const gitDir = checkpointGitDir(capabilities);
            // +1 for the "Initial empty commit" created by getRepository on first use
            expect(commitCount(gitDir)).toBe(2);
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
            expect(commitCount(gitDir)).toBe(3);
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
            expect(commitCount(gitDir)).toBe(3);
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
            const countAfterFirst = commitCount(gitDir);

            await checkpointDatabase(capabilities, "second – no change", db);

            expect(commitCount(gitDir)).toBe(countAfterFirst);
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
            expect(commitCount(gitDir)).toBe(2);
            expect(topLevelEntries(gitDir)).toEqual([DATABASE_SUBPATH]);
            expect(allTrackedFiles(gitDir)).toEqual([`${DATABASE_SUBPATH}/_meta/format`]);
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
            expect(topLevelEntries(gitDir)).toEqual([DATABASE_SUBPATH]);
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
            const tracked = allTrackedFiles(gitDir);
            expect(tracked).toContain(`${DATABASE_SUBPATH}/_meta/format`);
            expect(tracked).toContain(
                `${DATABASE_SUBPATH}/${keyToRelativePath('!x!!values!{"head":"event","args":["one"]}')}`
            );
            expect(tracked).toContain(`${DATABASE_SUBPATH}/x/meta/version`);
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
                    gitDir,
                    `${DATABASE_SUBPATH}/${keyToRelativePath('!x!!values!{"head":"event","args":["hello"]}')}`
                )
            ).toBe(JSON.stringify({ message: "hello-content" }));
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
            const tracked = allTrackedFiles(gitDir);
            expect(tracked).toContain(`${DATABASE_SUBPATH}/${keyToRelativePath(oldKey)}`);
            expect(tracked).toContain(`${DATABASE_SUBPATH}/${keyToRelativePath(newKey)}`);
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
                fileContentAtHead(gitDir, `${DATABASE_SUBPATH}/${keyToRelativePath(key)}`)
            ).toBe(JSON.stringify({ version: "version-2" }));
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
            expect(commitCount(gitDir)).toBeGreaterThanOrEqual(2);
            expect(
                fileContentAtHead(gitDir, `${DATABASE_SUBPATH}/${keyToRelativePath(key)}`)
            ).toBe(JSON.stringify({ value: "base" }));
        } finally {
            await db.close();
        }
    });
});
