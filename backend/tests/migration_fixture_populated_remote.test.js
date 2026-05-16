const fs = require("fs");
const path = require("path");
const { makeInterface } = require("../src/generators/interface");
const { DATABASE_SUBPATH } = require("../src/generators/incremental_graph/database");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubDatetime, stubLogger } = require("./stubs");
const { stubIncrementalDatabaseRemoteBranches } = require("./stub_incremental_database_remote");
const { forceVersion } = require("./migration_fixture_helpers");

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
    test("migrating lastversion fixture rewrites the remote snapshot to identifier-addressed storage", async () => {
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
            const renderedDir = path.join(clonedRemote, DATABASE_SUBPATH, "r");
            const valuesDir = path.join(renderedDir, "values");
            const globalDir = path.join(renderedDir, "global");

            const valueFiles = fs.readdirSync(valuesDir).sort();
            expect(valueFiles.length).toBeGreaterThan(0);
            expect(valueFiles.every((name) => /^[a-z]{9}$/.test(name))).toBe(true);
            expect(fs.readdirSync(globalDir)).toContain("identifiers_keys_map");
            expect(valueFiles).not.toContain("all_events");
            expect(valueFiles).not.toContain("config");
            expect(valueFiles).not.toContain("events_count");

            expect(
                await capabilities.checker.fileExists(
                    path.join(globalDir, "identifiers_keys_map")
                )
            ).toBeTruthy();
        } finally {
            await capabilities.deleter.deleteDirectory(clonedRemote);
        }
    });
});
