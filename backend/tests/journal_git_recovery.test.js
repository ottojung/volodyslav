const {
    gitInstallationRecoverySource, isRecoveryDefinitelyAbsent, isRecoveryExists,
    isRecoveryIndeterminate, queryInstallationRecovery,
} = require('../src/generators/incremental_graph');
const { getMockedRootCapabilities } = require('./spies');
const { stubEnvironment, stubLogger } = require('./stubs');
const { stubIncrementalDatabaseRemoteBranches } = require('./stub_incremental_database_remote');
const {
    makeContinuationSafeSnapshot,
} = require('../src/generators/incremental_graph/journal_recovery_source');
const {
    makeJournalAuthor,
    makeJournalSequence,
    makeJournalRecordId,
    makeAuthorityTime,
    makeJournalFrontier,
    makeValueEvent,
} = require('../src/generators/incremental_graph/journal');
const { ProjectionClass } = require('../src/generators/incremental_graph/journal/oracle');

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

test('a recovery snapshot owns an immutable copy of its retained records', () => {
    const author = makeJournalAuthor('aaaaaaaaa');
    const sequence = makeJournalSequence('1');
    const id = makeJournalRecordId(author, sequence);
    const context = makeJournalFrontier([[author, makeJournalSequence('0')]]);
    const authorityTime = makeAuthorityTime(1, '0');
    const event = makeValueEvent(
        { id, context, authorityTime, node: { head: 'node', args: [] } },
        '1-aaaaaaaaa',
        { type: 'calories', value: 1 },
        '1970-01-01T00:00:00.000Z',
        '1970-01-01T00:00:00.001Z',
        'compute'
    );
    const records = [event];
    const snapshot = makeContinuationSafeSnapshot({
        localWriter: author,
        records,
        projection: new ProjectionClass([], new Map(), 0, author, new Set(), new Set()),
        writerState: {
            localWriter: author,
            writerHead: sequence,
            committedFrontier: context,
            authorityHighWater: authorityTime,
            allocatorWatermark: 1,
        },
        databaseVersion: '1',
        graphSchemeString: '{}',
    });

    if (snapshot instanceof Error) throw snapshot;
    expect(Object.isFrozen(snapshot.records)).toBe(true);
    records.pop();
    expect(snapshot.records).toEqual([event]);
    expect(() => snapshot.records.push(event)).toThrow(TypeError);
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
