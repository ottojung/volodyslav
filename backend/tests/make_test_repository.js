const fs = require("fs/promises");
const path = require("path");
const { execSync } = require("child_process");
const { eventLogDirectory } = require("../src/environment");

async function makeTestRepository() {
    // Create a temporary directory for our test repository
    const testRepoPath = eventLogDirectory();
    await fs.mkdir(testRepoPath, {
        recursive: true,
    });
    const testGitDir = path.join(testRepoPath, ".git");

    // Initialize a git repository
    execSync("git init", { cwd: testRepoPath });

    // Create an initial commit
    const testFile = path.join(testRepoPath, "test.txt");
    await fs.writeFile(testFile, "initial content");
    execSync("git -c user.name=1 -c user.email=1 add .", { cwd: testRepoPath });
    execSync("git -c user.name=1 -c user.email=1 commit -m 'Initial commit'", {
        cwd: testRepoPath,
    });

    return { testRepoPath, testGitDir };
}

module.exports = makeTestRepository;
