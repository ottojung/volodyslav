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
const { checkpointDatabase, CHECKPOINT_WORKING_PATH, DATABASE_SUBPATH } = require("../src/generators/incremental_graph/database");
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

// ── Helpers to write fake LevelDB files ──────────────────────────────────────

/**
 * Write fake "LevelDB" content into DATABASE_SUBPATH inside the checkpoint repo.
 * @param {object} capabilities
 * @param {string} filename   - name of the file to write (inside DATABASE_SUBPATH)
 * @param {string} content
 */
async function writeDatabaseFile(capabilities, filename, content) {
    const dir = path.join(
        capabilities.environment.workingDirectory(),
        CHECKPOINT_WORKING_PATH,
        DATABASE_SUBPATH
    );
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, filename), content);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("checkpointDatabase", () => {

    // ── Basic commit behaviour ────────────────────────────────────────────────

    test("creates a commit when called for the first time", async () => {
        const capabilities = getTestCapabilities();
        await writeDatabaseFile(capabilities, "MANIFEST-000001", "level db data");

        await checkpointDatabase(capabilities, "initial checkpoint");

        const gitDir = checkpointGitDir(capabilities);
        // +1 for the "Initial empty commit" created by getRepository on first use
        expect(commitCount(gitDir)).toBe(2);
    });

    test("commit message matches the provided message", async () => {
        const capabilities = getTestCapabilities();
        await writeDatabaseFile(capabilities, "MANIFEST-000001", "data");

        await checkpointDatabase(capabilities, "my checkpoint message");

        const gitDir = checkpointGitDir(capabilities);
        expect(latestCommitMessage(gitDir)).toBe("my checkpoint message");
    });

    test("creates a new commit on every call", async () => {
        const capabilities = getTestCapabilities();

        // First checkpoint
        await writeDatabaseFile(capabilities, "000001.ldb", "v1");
        await checkpointDatabase(capabilities, "first");

        // Second checkpoint (updated file)
        await writeDatabaseFile(capabilities, "000001.ldb", "v2");
        await checkpointDatabase(capabilities, "second");

        const gitDir = checkpointGitDir(capabilities);
        // +1 for the "Initial empty commit" created by getRepository on first use
        expect(commitCount(gitDir)).toBe(3);
    });

    test("commit messages are recorded in order", async () => {
        const capabilities = getTestCapabilities();

        await writeDatabaseFile(capabilities, "file.ldb", "a");
        await checkpointDatabase(capabilities, "checkpoint-alpha");

        await writeDatabaseFile(capabilities, "file.ldb", "b");
        await checkpointDatabase(capabilities, "checkpoint-beta");

        const gitDir = checkpointGitDir(capabilities);
        // Most recent commit is beta
        expect(latestCommitMessage(gitDir)).toBe("checkpoint-beta");
        // +1 for the "Initial empty commit" created by getRepository on first use
        expect(commitCount(gitDir)).toBe(3);
    });

    // ── allow-empty ───────────────────────────────────────────────────────────

    test("does not commit when no files have changed", async () => {
        const capabilities = getTestCapabilities();

        await writeDatabaseFile(capabilities, "MANIFEST-000001", "static");
        await checkpointDatabase(capabilities, "first");
        const gitDir = checkpointGitDir(capabilities);
        const countAfterFirst = commitCount(gitDir);

        // No file changes – second checkpoint should be a no-op
        await checkpointDatabase(capabilities, "second – no change");

        // No new commit should have been created
        expect(commitCount(gitDir)).toBe(countAfterFirst);
    });

    test("can be called before any database files have been written", async () => {
        const capabilities = getTestCapabilities();
        // Call with an empty directory — no LevelDB files at all
        await checkpointDatabase(capabilities, "empty repo checkpoint");

        const gitDir = checkpointGitDir(capabilities);
        // Only the "Initial empty commit" created by getRepository on first use;
        // checkpointDatabase is a no-op when there is nothing to commit.
        expect(commitCount(gitDir)).toBe(1);
    });

    // ── Repository layout ─────────────────────────────────────────────────────

    test("database subdirectory is the only top-level entry in the repository", async () => {
        const capabilities = getTestCapabilities();
        await writeDatabaseFile(capabilities, "000042.ldb", "data");

        await checkpointDatabase(capabilities, "layout check");

        const gitDir = checkpointGitDir(capabilities);
        expect(topLevelEntries(gitDir)).toEqual([DATABASE_SUBPATH]);
    });

    test("database files are tracked inside DATABASE_SUBPATH in the commit tree", async () => {
        const capabilities = getTestCapabilities();
        await writeDatabaseFile(capabilities, "000001.ldb", "sst data");
        await writeDatabaseFile(capabilities, "MANIFEST-000002", "manifest");

        await checkpointDatabase(capabilities, "track files");

        const gitDir = checkpointGitDir(capabilities);
        const tracked = allTrackedFiles(gitDir);
        expect(tracked).toContain(`${DATABASE_SUBPATH}/000001.ldb`);
        expect(tracked).toContain(`${DATABASE_SUBPATH}/MANIFEST-000002`);
    });

    test("file content is correctly recorded in the commit", async () => {
        const capabilities = getTestCapabilities();
        await writeDatabaseFile(capabilities, "data.ldb", "hello-content");

        await checkpointDatabase(capabilities, "content check");

        const gitDir = checkpointGitDir(capabilities);
        expect(fileContentAtHead(gitDir, `${DATABASE_SUBPATH}/data.ldb`)).toBe("hello-content");
    });

    test("git repository is located inside CHECKPOINT_WORKING_PATH", async () => {
        const capabilities = getTestCapabilities();
        await checkpointDatabase(capabilities, "location check");

        // `.git` must exist at the expected path
        const gitDir = checkpointGitDir(capabilities);
        const stat = await fs.stat(gitDir);
        expect(stat.isDirectory()).toBe(true);
    });

    // ── History preservation ──────────────────────────────────────────────────

    test("files written in earlier calls remain in git history", async () => {
        const capabilities = getTestCapabilities();

        await writeDatabaseFile(capabilities, "old.ldb", "old content");
        await checkpointDatabase(capabilities, "first");

        await writeDatabaseFile(capabilities, "new.ldb", "new content");
        await checkpointDatabase(capabilities, "second");

        const gitDir = checkpointGitDir(capabilities);
        // The latest commit must contain both files
        const tracked = allTrackedFiles(gitDir);
        expect(tracked).toContain(`${DATABASE_SUBPATH}/old.ldb`);
        expect(tracked).toContain(`${DATABASE_SUBPATH}/new.ldb`);
    });

    test("updated file content is reflected in the latest commit", async () => {
        const capabilities = getTestCapabilities();

        await writeDatabaseFile(capabilities, "db.ldb", "version-1");
        await checkpointDatabase(capabilities, "v1");

        await writeDatabaseFile(capabilities, "db.ldb", "version-2");
        await checkpointDatabase(capabilities, "v2");

        const gitDir = checkpointGitDir(capabilities);
        expect(fileContentAtHead(gitDir, `${DATABASE_SUBPATH}/db.ldb`)).toBe("version-2");
    });

    // ── Concurrency ───────────────────────────────────────────────────────────

    test("concurrent calls are serialized: all changes are committed", async () => {
        const capabilities = getTestCapabilities();
        // Write an initial file so the repo exists before the race
        await writeDatabaseFile(capabilities, "base.ldb", "base");

        await Promise.all([
            checkpointDatabase(capabilities, "concurrent-1"),
            checkpointDatabase(capabilities, "concurrent-2"),
        ]);

        const gitDir = checkpointGitDir(capabilities);
        // The file must be committed; both concurrent calls must settle without error.
        // +1 for the "Initial empty commit" created by getRepository on first use
        // +1 for the actual commit (one or both concurrent calls may produce a commit)
        expect(commitCount(gitDir)).toBeGreaterThanOrEqual(2);
        // The file written before the race must be present at HEAD
        expect(fileContentAtHead(gitDir, `${DATABASE_SUBPATH}/base.ldb`)).toBe("base");
    });
});
