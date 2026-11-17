const {
    gitCanonicalBootstrapSource,
} = require('../src/generators/incremental_graph');
const {
    isCanonicalBootstrapDefinitelyAbsent,
    isCanonicalBootstrapExists,
    publishedArtifactIsStagedCandidate,
    queryCanonicalBootstrap,
    readLegacyBootstrapState,
    stageCanonicalBootstrap,
} = require('../src/generators/incremental_graph/journal/bootstrap');
const {
    makeJournalAuthor,
    nodeKeyToCanonicalString,
} = require('../src/generators/incremental_graph/journal');
const { getMockedRootCapabilities } = require('./spies');
const { stubEnvironment, stubLogger } = require('./stubs');
const { stubIncrementalDatabaseRemoteBranches } = require('./stub_incremental_database_remote');

jest.setTimeout(30000);

function candidateFor(writer) {
    const nodeKeyString = nodeKeyToCanonicalString({ head: 'entry_description', args: [] });
    const legacy = readLegacyBootstrapState({
        graphSchemeString: 'test-bootstrap-scheme',
        lastNodeIndex: 1,
        nodes: [{
            nodeKeyString, nodeIdentifier: '1-abcdefghi',
            payload: { type: 'entry_description', description: 'bootstrap' },
            createdAt: '2020-01-01T00:00:00.000Z',
            modifiedAt: '2020-01-02T00:00:00.000Z',
            upToDate: true,
            validInputs: [],
        }],
    });
    if (legacy instanceof Error) throw legacy;
    const candidate = stageCanonicalBootstrap({
        legacyState: legacy,
        creatorWriter: makeJournalAuthor(writer),
        targetVersion: '3',
    });
    if (candidate instanceof Error) throw candidate;
    return candidate;
}

test('Git canonical slot publishes a frozen cut once and rejects a competing cut', async () => {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    await stubIncrementalDatabaseRemoteBranches(capabilities, []);

    const source = gitCanonicalBootstrapSource(capabilities);
    if (source instanceof Error) throw source;
    expect(isCanonicalBootstrapDefinitelyAbsent(await queryCanonicalBootstrap(source))).toBe(true);

    const winner = candidateFor('aaaaaaaaa');
    const first = await source.publishCanonicalBootstrapIfAbsent(winner);
    expect(first.published).toBe(true);
    expect(publishedArtifactIsStagedCandidate(first.artifact, winner)).toBe(true);

    const loser = candidateFor('bbbbbbbbb');
    const second = await source.publishCanonicalBootstrapIfAbsent(loser);
    expect(second.alreadyExists).toBe(true);
    expect(publishedArtifactIsStagedCandidate(second.artifact, winner)).toBe(true);

    const observed = await queryCanonicalBootstrap(source);
    expect(isCanonicalBootstrapExists(observed)).toBe(true);
    expect(publishedArtifactIsStagedCandidate(observed.artifact, winner)).toBe(true);
});

test('competing Git publishers cannot both win the absent slot', async () => {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    await stubIncrementalDatabaseRemoteBranches(capabilities, []);
    const a = gitCanonicalBootstrapSource(capabilities);
    const b = gitCanonicalBootstrapSource(capabilities);
    if (a instanceof Error) throw a;
    if (b instanceof Error) throw b;

    const [first, second] = await Promise.all([
        a.publishCanonicalBootstrapIfAbsent(candidateFor('aaaaaaaaa')),
        b.publishCanonicalBootstrapIfAbsent(candidateFor('bbbbbbbbb')),
    ]);
    expect([first, second].filter(x => x.published === true)).toHaveLength(1);
    expect([first, second].filter(x => x.alreadyExists === true)).toHaveLength(1);
    expect(first.artifact.creatorWriter.__value).toBe(second.artifact.creatorWriter.__value);
});
