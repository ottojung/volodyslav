const fs = require("fs").promises;
const path = require("path");
const { execSync } = require("child_process");
const { transaction } = require("../src/gitstore");
const temporary = require("./temporary");
const makeTestRepository = require("./make_test_repository");

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

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

    test("transaction cleans up temporary work tree", async () => {
        const { testGitDir } = await makeTestRepository();
        let temporaryWorkTree;

        await expect(
            transaction(testGitDir, async (store) => {
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
        const { testGitDir } = await makeTestRepository();
        let temporaryWorkTree;

        await expect(
            transaction(testGitDir, async (store) => {
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
});
