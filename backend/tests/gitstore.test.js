const fs = require("fs").promises;
const path = require("path");
const { execFileSync } = require("child_process");
const { transaction } = require("../src/gitstore");
const temporary = require("./temporary");
const makeTestRepository = require("./make_test_repository");
const defaultBranch = require("../src/gitstore/default_branch");
const workingRepository = require("../src/gitstore/working_repository");
const { getMockedRootCapabilities } = require("./mockCapabilities");

beforeEach(temporary.beforeEach);
afterEach(temporary.afterEach);

// Mock environment exports to avoid real env dependencies
jest.mock("../src/environment", () => {
    const temporary = require("./temporary");
    const path = require("path");
    return {
        eventLogRepository: jest.fn().mockImplementation(() => {
            const dir = temporary.input();
            return path.join(dir, "event_log");
        }),
        workingDirectory: jest.fn().mockImplementation(() => {
            return path.join(temporary.output(), "wd");
        }
        ),
    };
});

const capabilities = getMockedRootCapabilities();

describe("gitstore", () => {
    test("transaction allows reading and writing files", async () => {
        await makeTestRepository();
        await transaction(capabilities, async (store) => {
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
        const gitDir = await workingRepository.getRepository(capabilities);
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
        await makeTestRepository();
        await transaction(capabilities, async (store) => {
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
        const gitDir = await workingRepository.getRepository(capabilities);
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
        await makeTestRepository();
        let temporaryWorkTree;

        await expect(
            transaction(capabilities, async (store) => {
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
        await makeTestRepository();
        let temporaryWorkTree;

        await expect(
            transaction(capabilities, async (store) => {
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
