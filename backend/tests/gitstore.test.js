const fs = require("fs").promises;
const path = require("path");
const { execFileSync } = require("child_process");
const { transaction } = require("../src/gitstore");
const temporary = require("./temporary");
const makeTestRepository = require("./make_test_repository");
const defaultBranch = require("../src/gitstore/default_branch");

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

// Mock environment exports to avoid real env dependencies
jest.mock("../src/environment", () => {
    const temporary = require("./temporary");
    const path = require("path");
    return {
        eventLogDirectory: jest.fn().mockImplementation(() => {
            const dir = temporary.input();
            return path.join(dir, "event_log");
        }),
    };
});

describe("gitstore", () => {
    test("transaction allows reading and writing files", async () => {
        const { gitDir } = await makeTestRepository();
        await transaction(gitDir, async (store) => {
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
        const output = execFileSync("git", [
            "--git-dir",
            gitDir,
            "cat-file",
            "-p",
            `${defaultBranch}:test.txt`,
        ]);
        expect(output.toString().trim()).toBe("modified content");
    });

    test("transaction allows multiple commits", async () => {
        const { gitDir } = await makeTestRepository();
        await transaction(gitDir, async (store) => {
            const workTree = await store.getWorkTree();
            const testFile = path.join(workTree, "test.txt");

            // First modification
            await fs.writeFile(testFile, "first modification");
            await store.commit("First modification");

            // Second modification
            await fs.writeFile(testFile, "second modification");
            await store.commit("Second modification");
        });

        const commitCount = execFileSync("git", [
            "--git-dir",
            gitDir,
            "rev-list",
            "--count",
            defaultBranch,
        ]);
        expect(parseInt(commitCount)).toBe(3); // Initial + 2 modifications

        // Verify the final content
        const output = execFileSync("git", [
            "--git-dir",
            gitDir,
            "cat-file",
            "-p",
            `${defaultBranch}:test.txt`,
        ]);
        expect(output.toString().trim()).toBe("second modification");
    });

    test("transaction cleans up temporary work tree", async () => {
        const { gitDir } = await makeTestRepository();
        let temporaryWorkTree;

        await expect(
            transaction(gitDir, async (store) => {
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
        const { gitDir } = await makeTestRepository();
        let temporaryWorkTree;

        await expect(
            transaction(gitDir, async (store) => {
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

    test("transaction works with repositories that have dubious ownership", async () => {
        const { gitDir } = await makeTestRepository();

        // Change owner of the git directory to a different user.
        try {
            // TODO: ensure that these IDs are different from the current user.
            await fs.chown(gitDir, 1001, 1001, { recursive: true });
        } catch (err) {
            console.error();
            console.error();
            console.error("Failed to change ownership:", err);
            console.error("Skipping test due to permission issues.");
            console.error();
            console.error();
            return;
        }

        // Execute transaction on the restricted repository
        await transaction(gitDir, async (store) => {
            const workTree = await store.getWorkTree();
            const testFile = path.join(workTree, "test.txt");

            // Verify initial content
            const content = await fs.readFile(testFile, "utf8");
            expect(content).toBe("initial content");

            // Modify the file
            await fs.writeFile(testFile, "modified by different user");
            await store.commit("Modified with dubious ownership");
        });

        // Reset permissions to ensure we can verify the content
        await fs.chmod(gitDir, 0o755);

        // Verify the changes were committed by reading directly from the repo
        const output = execFileSync("git", [
            "--git-dir",
            gitDir,
            "cat-file",
            "-p",
            `${defaultBranch}:test.txt`,
        ]);
        expect(output.toString().trim()).toBe("modified by different user");
    });
});
