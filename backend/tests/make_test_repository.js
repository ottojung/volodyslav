const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const { eventLogDirectory } = require("../src/environment");
const { promisify } = require("node:util");

const callSubprocess = promisify(execFile);

async function makeTestRepository() {
    // Create a temporary directory for our test repository
    const workTree = eventLogDirectory();
    await fs.mkdir(workTree, {
        recursive: true,
    });
    const gitDir = path.join(workTree, ".git");

    // Initialize a git repository
    await callSubprocess("git init", { cwd: workTree, shell: true });

    // Create an initial commit
    const testFile = path.join(workTree, "test.txt");
    await fs.writeFile(testFile, "initial content");
    const dataFile = path.join(workTree, "data.json");
    await fs.writeFile(dataFile, "");
    await callSubprocess("git -c user.name=1 -c user.email=1 add --all", {
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

    return { workTree, gitDir };
}

module.exports = makeTestRepository;
