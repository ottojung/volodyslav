const {
    gitInstallationRecoverySource, isRecoveryDefinitelyAbsent, isRecoveryExists,
    isRecoveryIndeterminate, queryInstallationRecovery,
} = require('../src/generators/incremental_graph');
const { getMockedRootCapabilities } = require('./spies');
const { stubEnvironment, stubLogger } = require('./stubs');
const { stubIncrementalDatabaseRemoteBranches } = require('./stub_incremental_database_remote');

jest.setTimeout(30000);

test('an absent Git branch gives definite absence', async () => {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    await stubIncrementalDatabaseRemoteBranches(capabilities, []);
    const result = await queryInstallationRecovery(gitInstallationRecoverySource(capabilities));
    expect(isRecoveryDefinitelyAbsent(result)).toBe(true);
});

test('a failed Git query must not give definite absence', async () => {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    capabilities.environment.generatorsRepository = () => '/nonexistent/journal3-recovery-repository';
    const result = await queryInstallationRecovery(gitInstallationRecoverySource(capabilities));
    expect(isRecoveryIndeterminate(result)).toBe(true);
    expect(isRecoveryDefinitelyAbsent(result)).toBe(false);
});

test('held Git checkpoint reconstructs a writer and its retained records', async () => {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    await stubIncrementalDatabaseRemoteBranches(capabilities, [
        { hostname: capabilities.environment.hostname(), fixtureName: 'populated' },
    ]);
    const result = await queryInstallationRecovery(gitInstallationRecoverySource(capabilities));
    expect(isRecoveryExists(result)).toBe(true);
    if (!isRecoveryExists(result)) return;
    expect(result.snapshot.records.length).toBeGreaterThan(0);
    expect(result.snapshot.writerState.localWriter).toBe(result.snapshot.localWriter);
});

test('fresh startup creates an empty replica only after Git confirms own branch absent', async () => {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    await stubIncrementalDatabaseRemoteBranches(capabilities, []);
    const { makeInterface } = require('../src/generators/interface');
    const { readRetainedJournal } = require('../src/generators/incremental_graph/journal_store');
    const iface = makeInterface(() => capabilities);
    await iface.ensureInitialized();
    const replica = await readRetainedJournal(iface._database.getSchemaStorage().journal);
    if (replica instanceof Error) throw replica;
    expect([...replica.values()].flat()).toHaveLength(0);
    await iface._database.close();
});
