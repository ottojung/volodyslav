const path = require("path");
const { makeInterface } = require("../src/generators/interface");
const { DATABASE_SUBPATH } = require("../src/generators/incremental_graph/database");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubDatetime, stubLogger } = require("./stubs");
const { stubIncrementalDatabaseRemoteBranches } = require("./stub_incremental_database_remote");
const { forceVersion, assertDirectoriesExactlyEqual } = require("./migration_fixture_helpers");

jest.setTimeout(30000);

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    stubLogger(capabilities);
    forceVersion(capabilities, "0.0.0-dev");
    return capabilities;
}

describe("populated rendered fixture migration", () => {
    test("migrating lastversion fixture reproduces current populated fixture exactly", async () => {
        const capabilities = getTestCapabilities();
        await stubIncrementalDatabaseRemoteBranches(capabilities, [
            {
                hostname: capabilities.environment.hostname(),
                fixtureName: "populated-lastversion",
            },
        ]);

        const generators = makeInterface(() => capabilities);
        await generators.ensureInitialized();
        await generators.synchronizeDatabase();

        const clonedRemote = await capabilities.creator.createTemporaryDirectory();
        try {
            await capabilities.git.call(
                "clone",
                `--branch=${capabilities.environment.hostname()}-main`,
                capabilities.environment.generatorsRepository(),
                clonedRemote
            );

            expect(await capabilities.checker.directoryExists(clonedRemote)).toBeTruthy();
            await assertDirectoriesExactlyEqual(
                path.join(clonedRemote, DATABASE_SUBPATH),
                path.join(__dirname, "mock-incremental-database-remote-populated", DATABASE_SUBPATH)
            );
        } finally {
            await capabilities.deleter.deleteDirectory(clonedRemote);
        }
    });
});
