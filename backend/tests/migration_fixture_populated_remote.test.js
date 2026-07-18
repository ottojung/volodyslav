const path = require("path");
const { makeInterface } = require("../src/generators/interface");
const { CHECKPOINT_WORKING_PATH } = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubDatetime, stubLogger, stubRandomSeed } = require("./stubs");
const { stubIncrementalDatabaseRemoteBranches } = require("./stub_incremental_database_remote");
const { forceVersion, assertDirectoriesExactlyEqual } = require("./migration_fixture_helpers");

jest.setTimeout(30000);

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    stubLogger(capabilities);
    stubRandomSeed(capabilities);
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
        await expect(generators.getAllEvents()).resolves.toHaveLength(26);

        await assertDirectoriesExactlyEqual(
            path.join(capabilities.environment.workingDirectory(), CHECKPOINT_WORKING_PATH, "rendered", "r"),
            path.join(__dirname, "mock-incremental-database-remote-populated", "rendered", "r"),
            new Set(["global/version"])
        );
    });
});
