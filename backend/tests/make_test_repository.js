const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { eventLogDirectory } = require("../src/environment");
const { promisify } = require("node:util");

const callSubprocess = promisify(execFile);

async function makeTestRepository() {
    // Create a temporary directory for our test repository
    const testRepoPath = eventLogDirectory();
    await fs.mkdir(testRepoPath, {
        recursive: true,
    });
    const testGitDir = path.join(testRepoPath, ".git");

    // Initialize a git repository
    await callSubprocess("git init", { cwd: testRepoPath, shell: true });

    // Create an initial commit
    const testFile = path.join(testRepoPath, "test.txt");
    await fs.writeFile(testFile, "initial content");
    await callSubprocess("git -c user.name=1 -c user.email=1 add .", {
        cwd: testRepoPath,
        shell: true,
    });
    await callSubprocess(
        "git -c user.name=1 -c user.email=1 commit -m 'Initial commit'",
        {
            cwd: testRepoPath,
            shell: true,
        }
    );

    return { testRepoPath, testGitDir };
}

module.exports = makeTestRepository;
