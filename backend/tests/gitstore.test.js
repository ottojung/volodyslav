const fs = require("fs").promises;
const path = require("path");
const { execFileSync } = require("child_process");
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

describe("gitstore", () => {
    test("transaction allows reading and writing files", async () => {
        const capabilities = getTestCapabilities();
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
            `${defaultBranch}:test.txt`,
        ]);
        expect(output.toString().trim()).toBe("modified content");
    });

    test("transaction allows multiple commits", async () => {
        const capabilities = getTestCapabilities();
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
});
