const path = require("path");
const fsPromises = require("fs/promises");
const { makeInterface } = require("../src/generators/interface");
const { CHECKPOINT_WORKING_PATH } = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubDatetime, stubLogger, stubRandomSeed } = require("./stubs");
const { stubIncrementalDatabaseRemoteBranches } = require("./stub_incremental_database_remote");
const { forceVersion, assertDirectoriesExactlyEqual } = require("./migration_fixture_helpers");
const {
    fixtureAbsentCohortSource,
    fixtureIndeterminateCohortSource,
    fixtureInputKeys,
    fixtureRecoverySourceHolding,
    readFixtureReplica,
} = require("./journal_startup_fixture");
const { makeJournalAuthor } = require("../src/generators/incremental_graph/journal");
const {
    isUnresolvedStartupCanonicalBootstrap,
    resolveCanonicalBootstrapForStartup,
} = require("../src/generators/incremental_graph/journal_bootstrap_startup");

jest.setTimeout(30000);

const CURRENT_VERSION = "0.0.0-dev";
const PREVIOUS_VERSION = "0.0.0-dev-previous";
const POPULATED_FIXTURE = path.join(__dirname, "mock-incremental-database-remote-populated", "rendered", "r");
const LASTVERSION_FIXTURE = path.join(
    __dirname,
    "mock-incremental-database-remote-populated-lastversion",
    "rendered",
    "r"
);

/**
 * @param {import("../src/capabilities/root").Capabilities} capabilities
 * @returns {string}
 */
function renderedReplicaPath(capabilities) {
    return path.join(
        capabilities.environment.workingDirectory(),
        CHECKPOINT_WORKING_PATH,
        "rendered",
        "r"
    );
}

/**
 * Bootstraps a fresh capabilities set whose forced application version differs
 * from the version the populated-lastversion fixture stores, so the migration
 * path is entered instead of its `prevVersion === currentVersion` early exit.
 *
 * @returns {Promise<import("../src/capabilities/root").Capabilities>}
 */
async function getMigratingCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    stubLogger(capabilities);
    stubRandomSeed(capabilities);
    forceVersion(capabilities, CURRENT_VERSION);
    await stubIncrementalDatabaseRemoteBranches(capabilities, [
        {
            hostname: capabilities.environment.hostname(),
            fixtureName: "populated-lastversion",
        },
    ]);
    // The live database is completely absent, so the §4 absent-state decision
    // runs: the deployment's recovery source holds the lastversion fixture's
    // continuation-safe snapshot, which startup restores before the ordinary
    // migration gate upgrades it to the forced current version.
    const recoverySource = fixtureRecoverySourceHolding(LASTVERSION_FIXTURE);
    if (recoverySource instanceof Error) {
        throw recoverySource;
    }
    capabilities.installationRecoverySource = recoverySource;
    return capabilities;
}

/**
 * Runs the interface over the populated-lastversion fixture and returns it,
 * failing unless a migration from {@link PREVIOUS_VERSION} to
 * {@link CURRENT_VERSION} actually ran. Every assertion in this file reads the
 * rendered replica this produces, so a run which leaves the migration path
 * through its equal-version early exit fails here instead of comparing a
 * directory against itself.
 *
 * @param {import("../src/capabilities/root").Capabilities} capabilities
 * @returns {Promise<import("../src/generators/interface").Interface>}
 */
async function migrateLastversionFixture(capabilities) {
    const generators = makeInterface(() => capabilities);
    await generators.ensureInitialized();

    const infoMessages = capabilities.logger.logInfo.mock.calls.map((call) => call[1]);
    if (!infoMessages.includes(`Starting migration from ${PREVIOUS_VERSION} to ${CURRENT_VERSION}`)) {
        throw new Error(
            `no migration ran; the interface logged ${JSON.stringify(infoMessages)} instead of a migration from ${PREVIOUS_VERSION} to ${CURRENT_VERSION}`
        );
    }
    return generators;
}

/**
 * @param {import("../src/capabilities/root").Capabilities} capabilities
 * @returns {Promise<Array<string>>}
 */
async function listJournalFiles(capabilities) {
    return (await fsPromises.readdir(path.join(renderedReplicaPath(capabilities), "journal"))).sort();
}

describe("populated rendered fixture migration", () => {
    test("a migration actually runs instead of leaving through the equal-version early exit", async () => {
        const storedVersion = JSON.parse(
            await fsPromises.readFile(path.join(LASTVERSION_FIXTURE, "global", "version"), "utf8")
        );
        expect(storedVersion).toBe(PREVIOUS_VERSION);
        expect(storedVersion).not.toBe(CURRENT_VERSION);

        const capabilities = await getMigratingCapabilities();
        const generators = await migrateLastversionFixture(capabilities);
        await expect(generators.getAllEvents()).resolves.toHaveLength(26);

        const infoMessages = capabilities.logger.logInfo.mock.calls.map((call) => call[1]);
        expect(infoMessages).toContain(`Starting migration from ${PREVIOUS_VERSION} to ${CURRENT_VERSION}`);
        expect(infoMessages).toContain(
            `Migration from ${PREVIOUS_VERSION} to ${CURRENT_VERSION} completed successfully.`
        );

        const migratedVersion = JSON.parse(
            await fsPromises.readFile(
                path.join(renderedReplicaPath(capabilities), "global", "version"),
                "utf8"
            )
        );
        expect(migratedVersion).toBe(CURRENT_VERSION);
    });

    test("migrating lastversion fixture reproduces current populated fixture exactly", async () => {
        const capabilities = await getMigratingCapabilities();
        const generators = await migrateLastversionFixture(capabilities);
        await expect(generators.getAllEvents()).resolves.toHaveLength(26);

        await assertDirectoriesExactlyEqual(renderedReplicaPath(capabilities), POPULATED_FIXTURE);
    });

    test("the migrated output carries the source history forward and stores it in the readable form", async () => {
        const capabilities = await getMigratingCapabilities();
        await migrateLastversionFixture(capabilities);

        const sourceJournal = path.join(LASTVERSION_FIXTURE, "journal");
        const migratedJournal = path.join(renderedReplicaPath(capabilities), "journal");
        const sourceFiles = (await fsPromises.readdir(sourceJournal)).sort();
        const migratedFiles = await listJournalFiles(capabilities);

        // The migration transports the retained history into the target replica
        // rather than rebuilding it, so every source record is still there and
        // still holds the bytes it was written with.
        for (const name of sourceFiles) {
            expect(migratedFiles).toContain(name);
            const source = await fsPromises.readFile(path.join(sourceJournal, name));
            const migrated = await fsPromises.readFile(path.join(migratedJournal, name));
            expect(migrated.equals(source)).toBe(true);
        }

        // The Journal sublevel is text-valued, so its stored form is the value
        // text itself. A JSON-encoded string there is the legacy double-encoded
        // form which the production reader rejects by name, so no migrated
        // journal file may hold one.
        for (const name of migratedFiles) {
            const text = await fsPromises.readFile(path.join(migratedJournal, name), "utf8");
            expect(text.startsWith('"')).toBe(false);
        }

        // The writer state records the local allocation watermark, and the
        // migrated replica's durable last_node_index is the same watermark, so
        // replay reconstructs the allocation watermark the replica persists.
        const writerState = JSON.parse(
            await fsPromises.readFile(path.join(migratedJournal, "state"), "utf8")
        );
        const lastNodeIndex = JSON.parse(
            await fsPromises.readFile(
                path.join(renderedReplicaPath(capabilities), "global", "last_node_index"),
                "utf8"
            )
        );
        expect(writerState.allocatorWatermark).toBe(lastNodeIndex);
    });
});

describe("Journal 3 startup canonical bootstrap over the pre-Journal fixture", () => {
    /**
     * The fixture replica as the startup gate's supported pre-Journal source.
     * @returns {object}
     */
    function source() {
        return readFixtureReplica(LASTVERSION_FIXTURE);
    }

    /**
     * @param {object} replica
     * @param {object} calls
     * @returns {Promise<unknown>}
     */
    function resolve(replica, calls) {
        return resolveCanonicalBootstrapForStartup({
            legacyState: replica.legacyState,
            localWriter: makeJournalAuthor(replica.fingerprint),
            target: { databaseVersion: CURRENT_VERSION, graphSchemeString: replica.graphSchemeString },
            source: fixtureAbsentCohortSource(calls),
            currentInputKeysOfNode: fixtureInputKeys(replica.graphSchemeString),
        });
    }

    test("the fixture replica is a supported pre-Journal source", () => {
        const replica = source();
        expect(replica.legacyState).not.toBeInstanceOf(Error);
        expect(replica.legacyState.nodes.length).toBeGreaterThan(0);
        expect(replica.version).toBe(PREVIOUS_VERSION);
        expect(replica.fingerprint).toBe("testfingerprnt");
    });

    test("a cohort with nothing held publishes this fixture's own cut and resumes the creator", async () => {
        const replica = source();
        const calls = { queries: 0, publications: 0, published: [] };
        const resolution = await resolve(replica, calls);
        expect(resolution).not.toBeInstanceOf(Error);
        expect(resolution.operation).toBe("resume-canonical-creator");
        expect(resolution.records.length).toBeGreaterThan(0);
        expect(calls.queries).toBe(1);
        expect(calls.publications).toBe(1);
        // The staged candidate is a pure function of persisted state, so its authority
        // times are the fixture's own timestamps rather than a publication clock.
        expect(resolution.projection.occurrences).toHaveLength(replica.legacyState.nodes.length);
        expect(resolution.databaseVersion).toBe(CURRENT_VERSION);
    });

    test("an indeterminate answer is unresolved and installs no cutover", async () => {
        const replica = source();
        const resolution = await resolveCanonicalBootstrapForStartup({
            legacyState: replica.legacyState,
            localWriter: makeJournalAuthor(replica.fingerprint),
            target: { databaseVersion: CURRENT_VERSION, graphSchemeString: replica.graphSchemeString },
            source: fixtureIndeterminateCohortSource(undefined),
            currentInputKeysOfNode: fixtureInputKeys(replica.graphSchemeString),
        });
        expect(isUnresolvedStartupCanonicalBootstrap(resolution)).toBe(true);
        expect(resolution).not.toHaveProperty("records");
        expect(resolution).not.toHaveProperty("projection");
    });

    test("a pre-Journal fixture with no configured cohort source fails closed", async () => {
        const replica = source();
        const resolution = await resolveCanonicalBootstrapForStartup({
            legacyState: replica.legacyState,
            localWriter: makeJournalAuthor(replica.fingerprint),
            target: { databaseVersion: CURRENT_VERSION, graphSchemeString: replica.graphSchemeString },
            currentInputKeysOfNode: fixtureInputKeys(replica.graphSchemeString),
        });
        expect(resolution).toBeInstanceOf(Error);
        expect(resolution.message).toMatch(/cohort bootstrap source/);
    });
});
