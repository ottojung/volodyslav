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

/**
 * Brings the migration source fixture into the form the migration expects, so
 * running this script is idempotent in the fixtures' favour:
 *
 * - the stored version must differ from the forced current version, otherwise
 *   the migration leaves through its equal-version early exit and the script
 *   would copy an unmigrated database over the populated fixture;
 * - the sublevels the current schema does not declare are removed, because the
 *   migration target carries only values, freshness, valid, timestamps, global
 *   and the journal, so leaving them in the source makes the source differ from
 *   its own migration output;
 * - the writer state records the replica's own allocation watermark, because a
 *   watermark below the durable last_node_index makes the migration append a
 *   writer-state record for an allocation that did not advance.
 *
 * @param {string} lastVersionFixture
 * @returns {Promise<void>}
 */
async function normalizeMigrationSourceFixture(lastVersionFixture) {
    const rendered = path.join(lastVersionFixture, "r");

    for (const sublevel of ["counters", "inputs", "revdeps"]) {
        await fs.rm(path.join(rendered, sublevel), { recursive: true, force: true });
    }

    const lastNodeIndex = JSON.parse(
        await fs.readFile(path.join(rendered, "global", "last_node_index"), "utf8")
    );
    const statePath = path.join(rendered, "journal", "state");
    const state = JSON.parse(await fs.readFile(statePath, "utf8"));
    if (state.allocatorWatermark !== lastNodeIndex) {
        state.allocatorWatermark = lastNodeIndex;
        await fs.writeFile(statePath, JSON.stringify(state));
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

    await fs.writeFile(path.join(lastVersionFixture, DATABASE_SUBPATH, "r/global/version"), JSON.stringify("0.0.0-dev-previous"));
    await normalizeMigrationSourceFixture(path.join(lastVersionFixture, DATABASE_SUBPATH));

    const capabilities = makeRootCapabilities();
    let seedCounter = 0;
    capabilities.seed = { generate: () => seedCounter++ };
    forceVersion(capabilities, "0.0.0-dev");
    await stubIncrementalDatabaseRemoteBranches(capabilities, [{ hostname: capabilities.environment.hostname(), fixtureName: "populated-lastversion" }]);

    const generators = makeInterface(() => capabilities);
    await generators.ensureInitialized();
    await generators.synchronizeDatabase();

    const cloneDirectory = await capabilities.creator.createTemporaryDirectory();
    try {
        await capabilities.git.call("clone", "--quiet", `--branch=${capabilities.environment.hostname()}-main`, capabilities.environment.generatorsRepository(), cloneDirectory);
        await copyDirectoryRecursively(path.join(cloneDirectory, DATABASE_SUBPATH), path.join(populatedFixture, DATABASE_SUBPATH));
    } finally {
        await capabilities.deleter.deleteDirectory(cloneDirectory);
    }
}

main();
