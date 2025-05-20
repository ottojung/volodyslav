const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { eventLogRepository } = require("../src/environment");
const { promisify } = require("node:util");
const temporary = require("./temporary");
const defaultBranch = require("../src/gitstore/default_branch");

const callSubprocess = promisify(execFile);

async function makeTestRepository() {
    // Let eventLogRepository be our test repository
    const gitDir = eventLogRepository();

    // Initialize a git repository
    await callSubprocess("git", ["init", "--bare", "--", gitDir]);

    // Create a worktree
    const workTree = path.join(temporary.input(), "worktree");
    await fs.mkdir(workTree, { recursive: true });
    await callSubprocess("git", [
        "init",
        "--initial-branch",
        defaultBranch,
        "--",
        workTree,
    ]);

    // Create some content
    const testFile = path.join(workTree, "test.txt");
    await fs.writeFile(testFile, "initial content");
    const dataFile = path.join(workTree, "data.json");
    await fs.writeFile(dataFile, "");

    // Add and commit the content
    await callSubprocess("git add --all", {
        cwd: workTree,
        shell: true,
    });
    await callSubprocess(
        "git -c user.name=1 -c user.email=1 commit -m 'Initial commit'",
        {
            cwd: workTree,
            shell: true,
        }
    );

    // Push the content to the bare repository
    await callSubprocess("git", ["remote", "add", "origin", "--", gitDir], {
        cwd: workTree,
    });
    await callSubprocess("git", ["push", "origin", defaultBranch], {
        cwd: workTree,
        shell: true,
    });

    await fs.rm(workTree, { recursive: true, force: true });
}

module.exports = makeTestRepository;
