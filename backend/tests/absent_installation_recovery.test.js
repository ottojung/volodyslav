/**
 * Tests for the absent-installation recovery decision.
 *
 * Startup on a completely absent local database consults the installation
 * recovery source, restores only a continuation-safe published head, creates a
 * fresh installation only on definite absence, and fails when the query or the
 * held snapshot is indeterminate. It never falls back to normal synchronization
 * from an empty local database.
 */

jest.setTimeout(30000);

const path = require("path");
const {
    makeInterface,
} = require("../src/generators/interface");
const {
    LIVE_DATABASE_WORKING_PATH,
    CHECKPOINT_WORKING_PATH,
} = require("../src/generators/incremental_graph");
const { stubPopulatedIncrementalDatabaseRemote } = require("./stub_incremental_database_remote");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger,
    stubEnvironment,
    stubDatetime,
    ensureLiveDatabaseDirectory,
} = require("./stubs");

const FRESH_INSTALLATION_MESSAGE =
    'Bootstrap: installation recovery source reports definite absence; creating a fresh installation';
const RESTORE_MESSAGE =
    'Bootstrap: installation recovery source reported a continuation-safe published head; restoring the absent installation';

/**
 * @returns {object}
 */
function makeRecoveryCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

/**
 * @param {object} capabilities
 * @returns {string}
 */
function liveDatabasePathOf(capabilities) {
    return path.join(
        capabilities.environment.workingDirectory(),
        LIVE_DATABASE_WORKING_PATH
    );
}

/**
 * Create a bare remote which publishes only `main`, so the installation's own
 * published branch is absent and the recovery source answers definitely absent.
 *
 * @param {object} capabilities
 * @returns {Promise<void>}
 */
async function stubRemoteWithoutInstallationBranch(capabilities) {
    const gitDir = capabilities.environment.generatorsRepository();
    await capabilities.git.call("init", "--bare", "--", gitDir);
    const workTree = path.join(
        capabilities.environment.workingDirectory(),
        "absent-recovery-setup"
    );
    await capabilities.creator.createDirectory(workTree);
    await capabilities.git.call(
        "init", "--initial-branch", "main", "--", workTree
    );
    const readmeFile = path.join(workTree, "README");
    const readmeObj = await capabilities.creator.createFile(readmeFile);
    await capabilities.writer.writeFile(readmeObj, "recovery test remote");
    await capabilities.git.call("-C", workTree, "add", "--all");
    await capabilities.git.call(
        "-C", workTree,
        "-c", "user.name=test",
        "-c", "user.email=test@example.com",
        "commit", "-m", "initial"
    );
    await capabilities.git.call("-C", workTree, "remote", "add", "origin", "--", gitDir);
    await capabilities.git.call("-C", workTree, "push", "origin", "main");
}

/**
 * Leave a checkpoint repository directory which git cannot fetch into, so the
 * recovery source reports a head it cannot deliver.
 *
 * @param {object} capabilities
 * @returns {Promise<void>}
 */
async function stubUndeliverableCheckpointRepository(capabilities) {
    const checkpointDir = path.join(
        capabilities.environment.workingDirectory(),
        CHECKPOINT_WORKING_PATH
    );
    const gitDir = path.join(checkpointDir, ".git");
    await capabilities.creator.createDirectory(gitDir);
    const headFile = path.join(gitDir, "HEAD");
    const headObj = await capabilities.creator.createFile(headFile);
    await capabilities.writer.writeFile(headObj, "not-a-ref\n");
}

describe("absent-installation recovery decision", () => {
    test("restores the absent installation from a continuation-safe published head", async () => {
        const capabilities = makeRecoveryCapabilities();
        ensureLiveDatabaseDirectory(capabilities);
        await stubPopulatedIncrementalDatabaseRemote(capabilities);
        await capabilities.deleter.deleteDirectory(liveDatabasePathOf(capabilities));

        const iface = makeInterface(() => capabilities);
        // The decision under test is taken before the migration gate runs, so a
        // failure raised by that later gate must not be read as a wrong decision.
        await iface.ensureInitialized().catch(() => undefined);

        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({ hostname: 'test-host' }),
            RESTORE_MESSAGE
        );
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            { publishedHead: expect.stringMatching(/^[0-9a-f]{40}$/) },
            'Bootstrap: absent installation restored from the published head'
        );
    });

    test("creates a fresh installation on definite absence without synchronizing", async () => {
        const capabilities = makeRecoveryCapabilities();
        ensureLiveDatabaseDirectory(capabilities);
        await stubRemoteWithoutInstallationBranch(capabilities);
        await capabilities.deleter.deleteDirectory(liveDatabasePathOf(capabilities));

        const iface = makeInterface(() => capabilities);
        await iface.ensureInitialized();

        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            {},
            FRESH_INSTALLATION_MESSAGE
        );
        const loggedMessages = capabilities.logger.logInfo.mock.calls.map((call) => call[1]);
        expect(loggedMessages).not.toContain('Bootstrap: hostname branch does not exist remotely; using normal sync fallback');
    });

    test("fails without creating a fresh installation when the published head cannot be held", async () => {
        const capabilities = makeRecoveryCapabilities();
        ensureLiveDatabaseDirectory(capabilities);
        await stubPopulatedIncrementalDatabaseRemote(capabilities);
        await stubUndeliverableCheckpointRepository(capabilities);
        await capabilities.deleter.deleteDirectory(liveDatabasePathOf(capabilities));

        const iface = makeInterface(() => capabilities);

        await expect(iface.ensureInitialized()).rejects.toMatchObject({
            name: 'AbsentInstallationRecoveryError',
        });
        const loggedMessages = capabilities.logger.logInfo.mock.calls.map((call) => call[1]);
        expect(loggedMessages).not.toContain(FRESH_INSTALLATION_MESSAGE);
    });
});