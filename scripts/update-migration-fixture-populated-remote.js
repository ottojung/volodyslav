const path = require("path");
const fs = require("fs/promises");
const { makeInterface } = require("../backend/src/generators/interface");
const { DATABASE_SUBPATH } = require("../backend/src/generators/incremental_graph/database");
const { make: makeRootCapabilities } = require("../backend/src/capabilities/root");
const { forceVersion } = require("../backend/tests/migration_fixture_helpers");
const { stubIncrementalDatabaseRemoteBranches } = require("../backend/tests/stub_incremental_database_remote");

async function copyDirectoryRecursively(source, destination) {
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(destination, { recursive: true });
    const members = await fs.readdir(source, { withFileTypes: true });
    for (const member of members) {
        const sourcePath = path.join(source, member.name);
        const destinationPath = path.join(destination, member.name);
        if (member.isDirectory()) {
            await copyDirectoryRecursively(sourcePath, destinationPath);
        } else {
            await fs.copyFile(sourcePath, destinationPath);
        }
    }
}

async function main() {
    const repoRoot = path.join(__dirname, "..");
    const tmpRoot = path.join(repoRoot, ".tmp", "migration-fixture-update");
    await fs.mkdir(tmpRoot, { recursive: true });
    process.env.VOLODYSLAV_OPENAI_API_KEY = process.env.VOLODYSLAV_OPENAI_API_KEY ?? "test";
    process.env.VOLODYSLAV_GEMINI_API_KEY = process.env.VOLODYSLAV_GEMINI_API_KEY ?? "test";
    process.env.VOLODYSLAV_WORKING_DIRECTORY = path.join(tmpRoot, "working");
    process.env.VOLODYSLAV_SERVER_PORT = process.env.VOLODYSLAV_SERVER_PORT ?? "3000";
    process.env.VOLODYSLAV_LOG_LEVEL = process.env.VOLODYSLAV_LOG_LEVEL ?? "info";
    process.env.VOLODYSLAV_LOG_FILE = path.join(tmpRoot, "volodyslav.log");
    process.env.VOLODYSLAV_DIARY_RECORDINGS_DIRECTORY = path.join(tmpRoot, "diary");
    process.env.VOLODYSLAV_EVENT_LOG_ASSETS_DIRECTORY = path.join(tmpRoot, "assets-dir");
    process.env.VOLODYSLAV_GENERATORS_REPOSITORY = path.join(tmpRoot, "generators-remote.git");
    process.env.VOLODYSLAV_EVENT_LOG_ASSETS_REPOSITORY = path.join(tmpRoot, "assets-remote.git");
    process.env.VOLODYSLAV_HOSTNAME = process.env.VOLODYSLAV_HOSTNAME ?? "test-host";
    process.env.VOLODYSLAV_ANALYZER_HOSTNAME = process.env.VOLODYSLAV_ANALYZER_HOSTNAME ?? "test-analyzer";

    const populatedFixture = path.join(repoRoot, "backend/tests/mock-incremental-database-remote-populated");
    const lastVersionFixture = path.join(repoRoot, "backend/tests/mock-incremental-database-remote-populated-lastversion");

    await copyDirectoryRecursively(populatedFixture, lastVersionFixture);
    await fs.writeFile(path.join(lastVersionFixture, DATABASE_SUBPATH, "r/global/version"), JSON.stringify("0.0.0-dev-previous"));

    const capabilities = makeRootCapabilities();
    forceVersion(capabilities, "0.0.0-dev");
    await stubIncrementalDatabaseRemoteBranches(capabilities, [{ hostname: capabilities.environment.hostname(), fixtureName: "populated-lastversion" }]);

    const generators = makeInterface(() => capabilities);
    await generators.ensureInitialized();
    await generators.synchronizeDatabase();

    const cloneDirectory = await capabilities.creator.createTemporaryDirectory();
    try {
        await capabilities.git.call("clone", `--branch=${capabilities.environment.hostname()}-main`, capabilities.environment.generatorsRepository(), cloneDirectory);
        await copyDirectoryRecursively(path.join(cloneDirectory, DATABASE_SUBPATH), path.join(populatedFixture, DATABASE_SUBPATH));
    } finally {
        await capabilities.deleter.deleteDirectory(cloneDirectory);
    }
}

main();
