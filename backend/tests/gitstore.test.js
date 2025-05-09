const os = require("os");
const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");
const { transaction } = require("../src/gitstore");
const temporary = require("./temporary");

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

async function makeTestRepository() {
    // Create a temporary directory for our test repository
    const testRepoPath = await fs.mkdir(`${temporary.input()}/gitstore-test`, {
        recursive: true,
    });
    const testGitDir = path.join(testRepoPath, ".git");

    // Initialize a git repository
    execSync("git init", { cwd: testRepoPath });

    // Configure git identity
    execSync("git config user.name 'Test User'", { cwd: testRepoPath });
    execSync("git config user.email 'test@example.com'", {
        cwd: testRepoPath,
    });

    // Create an initial commit
    const testFile = path.join(testRepoPath, "test.txt");
    await fs.writeFile(testFile, "initial content");
    execSync("git add .", { cwd: testRepoPath });
    execSync("git commit -m 'Initial commit'", { cwd: testRepoPath });

    return { testRepoPath, testGitDir };
}

describe("gitstore", () => {
    test("transaction allows reading and writing files", async () => {
        const { testRepoPath, testGitDir } = await makeTestRepository();
        await transaction(testGitDir, async (store) => {
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
        const output = execSync("git cat-file -p HEAD:test.txt", {
            cwd: testRepoPath,
            encoding: "utf8",
        });
        expect(output.trim()).toBe("modified content");
    });

    test("transaction allows multiple commits", async () => {
        const { testRepoPath, testGitDir } = await makeTestRepository();
        await transaction(testGitDir, async (store) => {
            const workTree = await store.getWorkTree();
            const testFile = path.join(workTree, "test.txt");

            // First modification
            await fs.writeFile(testFile, "first modification");
            await store.commit("First modification");

            // Second modification
            await fs.writeFile(testFile, "second modification");
            await store.commit("Second modification");
        });

        // Verify we have the correct number of commits
        const commitCount = execSync("git rev-list --count HEAD", {
            cwd: testRepoPath,
            encoding: "utf8",
        });
        expect(parseInt(commitCount)).toBe(3); // Initial + 2 modifications

        // Verify the final content
        const output = execSync("git cat-file -p HEAD:test.txt", {
            cwd: testRepoPath,
            encoding: "utf8",
        });
        expect(output.trim()).toBe("second modification");
    });

    test("transaction cleans up work tree even if transformation fails", async () => {
        const { testGitDir } = await makeTestRepository();
        await expect(
            transaction(testGitDir, async (store) => {
                await store.getWorkTree(); // Get the work tree to create it
                throw new Error("Test error");
            })
        ).rejects.toThrow("Test error");

        // Verify that no temporary directories are left behind
        const tempFiles = await fs.readdir(os.tmpdir());
        const gitStoreTempDirs = tempFiles.filter((name) =>
            name.startsWith("gitstore-")
        );
        expect(gitStoreTempDirs).toHaveLength(0);
    });
});
