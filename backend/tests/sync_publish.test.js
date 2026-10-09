/**
 * Lowering `project(Jfinal)` into a namespace, and the staging surface.
 *
 * Every fixture is a supported graph plus Journal pair in the sense of
 * `incremental-graph-journal-testing.md` §Reference replay oracle: it is built by
 * a writer which materializes a node and then validates it against the exact
 * current direct-input occurrences it observed, so the Journal is well formed
 * before synchronization sees it. The subject is the persistence half —
 * `publishSyncOutcome`, `readRetainedLengths` and the staging sublevel — which
 * is what `incremental-graph-journal-sync.md` §Atomic publication requires and
 * what `sync.md` §Atomic publication lowers.
 */

const {
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalSequence,
    makeJournalReplica,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    makeDeleteEvent,
    nodeKeyToCanonicalString,
    makeReplicaSource,
} = require('../src/generators/incremental_graph/journal');

const {
    isSyncOutcome,
    SnapshotIdentityClass,
    synchronizeRetainedJournal,
} = require('../src/generators/incremental_graph/journal_sync');

const {
    buildRetainedReplayState,
} = require('../src/generators/incremental_graph/journal_retained');

const {
    getRootDatabase,
    IDENTIFIERS_KEY,
    LAST_NODE_INDEX_KEY,
    nodeIdentifierToString,
    journalKeyToString,
    stringToJournalKey,
    stringToJournalText,
    journalTextToString,
} = require('../src/generators/incremental_graph/database');

const {
    publishSyncOutcome,
    planSyncPublication,
} = require('../src/generators/incremental_graph/journal_publish/sync_publish');

const {
    readRetainedLengths,
    retainedLengthTexts,
} = require('../src/generators/incremental_graph/database/sync_journal_source');

const {
    SYNC_STAGING_PERSISTED_NAMES,
    clearSyncStaging,
    syncStagingStorage,
} = require('../src/generators/incremental_graph/database/sync_staging');

const {
    readCurrentOccurrence,
    serializeWriterState,
} = require('../src/generators/incremental_graph/journal_store');

const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

const NODE_A = { head: 'event', args: [{ id: 1 }] };
const NODE_B = { head: 'event', args: [{ id: 2 }] };
const NODE_C = { head: 'event', args: [{ id: 3 }] };
const KEY_A = nodeKeyToCanonicalString(NODE_A);
const KEY_B = nodeKeyToCanonicalString(NODE_B);
const KEY_C = nodeKeyToCanonicalString(NODE_C);
const NOW = '2020-01-01T00:00:00.000Z';
const LATER = '2020-01-02T00:00:00.000Z';
const WRITER_LOCAL = 'aaaaaaaaa';
const WRITER_PEER = 'bbbbbbbbb';
const PAYLOAD = { type: 'entry_description', description: 'x' };
const INSTANT = 1700000000000;
const TEST_HOSTNAME = 'test-host-xyz';

/**
 * The chain schema `A -> B -> C`.
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function chainInputs(nodeKeyString) {
    if (nodeKeyString === KEY_B) {
        return [KEY_A];
    }
    if (nodeKeyString === KEY_C) {
        return [KEY_B];
    }
    return [];
}

/**
 * @param {ReadonlyArray<string>} coordinates
 */
function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
}

/**
 * The coordinates a writer's record at `sequence` observed: what the caller saw
 * plus the writer's own complete already-committed prefix.
 *
 * @param {string} writer
 * @param {string} sequence
 * @param {ReadonlyArray<string>} observed
 * @returns {ReadonlyArray<string>}
 */
function observedUpTo(writer, sequence, observed) {
    const previous = Number(sequence) - 1;
    if (previous === 0) {
        return [...observed];
    }
    return [...observed, [writer, String(previous)]];
}

/**
 * @template T
 * @param {T | Error} value
 * @returns {T}
 */
function made(value) {
    if (value instanceof Error) {
        throw new Error('the fixture built an invalid record: ' + value.message);
    }
    return value;
}

/**
 * @param {number} physical
 */
function authorityOf(physical) {
    return made(makeAuthorityTime(physical, '0'));
}

/**
 * @param {string} nodeKeyString
 */
function identifierOf(nodeKeyString) {
    return JSON.parse(nodeKeyString).args[0].id + '-abcdefghi';
}

/**
 * @param {object} occurrence
 * @param {string} occurrence.writer
 * @param {string} occurrence.sequence
 * @param {object} occurrence.node
 * @param {ReadonlyArray<string>} occurrence.context
 * @param {ReadonlyArray<{node: object, value: string}>} occurrence.basis
 */
function materialize(occurrence) {
    const nodeKey = nodeKeyToCanonicalString(occurrence.node);
    const valueId = occurrence.writer + ':' + occurrence.sequence;
    const valueSequence = String(Number(occurrence.sequence) + 1);
    return [
        made(makeValueEvent(
            {
                id: valueId,
                context: contextOf(observedUpTo(occurrence.writer, occurrence.sequence, occurrence.context)),
                authorityTime: authorityOf(Number(occurrence.sequence)),
                node: occurrence.node,
            },
            identifierOf(nodeKey),
            PAYLOAD,
            NOW,
            LATER,
            'compute'
        )),
        made(makeValidateEvent(
            {
                id: occurrence.writer + ':' + valueSequence,
                context: contextOf(observedUpTo(occurrence.writer, valueSequence, occurrence.context)),
                authorityTime: authorityOf(Number(valueSequence)),
                node: occurrence.node,
            },
            valueId,
            occurrence.basis.map((entry) => makeValidationBasisEntry(entry.node, entry.value)),
            'compute'
        )),
    ];
}

/**
 * A materialization with no validation, which is how a leaf becomes stale without
 * being self-proof-ready.
 *
 * @param {object} occurrence
 * @param {string} occurrence.writer
 * @param {string} occurrence.sequence
 * @param {object} occurrence.node
 * @param {ReadonlyArray<string>} occurrence.context
 */
function materializeOnly(occurrence) {
    return made(makeValueEvent(
        {
            id: occurrence.writer + ':' + occurrence.sequence,
            context: contextOf(observedUpTo(occurrence.writer, occurrence.sequence, occurrence.context)),
            authorityTime: authorityOf(Number(occurrence.sequence)),
            node: occurrence.node,
        },
        identifierOf(nodeKeyToCanonicalString(occurrence.node)),
        PAYLOAD,
        NOW,
        LATER,
        'compute'
    ));
}

/**
 * A peer's deletion of one node.
 * @param {object} deletion
 * @param {string} deletion.writer
 * @param {string} deletion.sequence
 * @param {object} deletion.node
 * @param {ReadonlyArray<string>} deletion.context
 */
function deletionOf(deletion) {
    return made(makeDeleteEvent(
        {
            id: deletion.writer + ':' + deletion.sequence,
            context: contextOf(deletion.context),
            authorityTime: authorityOf(Number(deletion.sequence)),
            node: deletion.node,
        },
        'operation'
    ));
}

/**
 * @param {ReadonlyArray<object>} records
 */
function replicaOf(records) {
    /** @type {Map<string, object[]>} */
    const byWriter = new Map();
    for (const record of records) {
        const name = journalAuthorToString(record.id.author);
        const stream = byWriter.get(name) ?? [];
        stream.push(record);
        byWriter.set(name, stream);
    }
    return makeJournalReplica([...byWriter.entries()]);
}

/**
 * @param {ReadonlyArray<object>} records
 * @param {number} authorityPhysical
 */
function committedAfter(records, authorityPhysical) {
    const own = records.filter((record) => journalAuthorToString(record.id.author) === WRITER_LOCAL);
    const last = own[own.length - 1];
    return {
        localWriter: made(makeJournalAuthor(WRITER_LOCAL)),
        writerHead: last === undefined ? made(makeJournalSequence('0')) : last.id.sequence,
        committedFrontier: contextOf(
            last === undefined ? [] : [[WRITER_LOCAL, journalSequenceToString(last.id.sequence)]]
        ),
        authorityHighWater: authorityOf(authorityPhysical),
        allocatorWatermark: 0,
    };
}

/**
 * @param {object} options
 * @param {ReadonlyArray<object>} options.receiver
 * @param {ReadonlyArray<object>} options.source
 * @param {number} options.authorityPhysical
 */
function synchronize(options) {
    const identity = new SnapshotIdentityClass('v1', 'scheme');
    return synchronizeRetainedJournal({
        receiver: makeReplicaSource(replicaOf(options.receiver)),
        source: makeReplicaSource(replicaOf(options.source)),
        localWriter: made(makeJournalAuthor(WRITER_LOCAL)),
        committed: committedAfter(options.receiver, options.authorityPhysical),
        observedHighWater: authorityOf(options.authorityPhysical),
        publicationInstant: INSTANT,
        currentInputKeysOfNode: chainInputs,
        receiverIdentity: identity,
        sourceIdentity: identity,
        retainedState: made(buildRetainedReplayState({
            source: makeReplicaSource(replicaOf(options.receiver)),
            localWriter: made(makeJournalAuthor(WRITER_LOCAL)),
            currentInputKeysOfNode: chainInputs,
        })).state,
    });
}

/**
 * @param {ReturnType<typeof synchronize>} result
 */
function outcomeOf(result) {
    if (!('outcome' in result)) {
        throw new Error('synchronization failed: ' + result.error.name + ' ' + result.error.message);
    }
    if (!isSyncOutcome(result.outcome)) {
        throw new Error('synchronization did not return an outcome');
    }
    return result.outcome;
}

/**
 * The receiver's supported pair for the chain schema: A proven from nothing, and B
 * proven against A's occurrence.
 */
function receiverChain() {
    return [
        ...materialize({ writer: WRITER_LOCAL, sequence: '1', node: NODE_A, context: [], basis: [] }),
        ...materialize({
            writer: WRITER_LOCAL,
            sequence: '3',
            node: NODE_B,
            context: [],
            basis: [{ node: NODE_A, value: WRITER_LOCAL + ':1' }],
        }),
    ];
}

function makeTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    capabilities.environment.hostname = () => TEST_HOSTNAME;
    return capabilities;
}

/**
 * @param {import('../src/generators/incremental_graph/database').RootDatabase} db
 */
async function journalSublevelOf(db) {
    return db.replicaNamespaceSublevel(db.currentReplicaName()).sublevel('journal', {
        valueEncoding: 'utf8',
    });
}

/**
 * Every persisted key the whole root instance holds.
 * @param {import('../src/generators/incremental_graph/database').RootDatabase} db
 */
async function everyPersistedKey(db) {
    /** @type {Array<string>} */
    const keys = [];
    for await (const key of db.db.keys()) {
        keys.push(String(key));
    }
    return keys;
}

describe('publishSyncOutcome, lowering project(Jfinal)', () => {
    test('the committed graph is exactly the projection, occurrence by occurrence', async () => {
        const capabilities = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            const peerAddsC = materialize({
                writer: WRITER_PEER,
                sequence: '1',
                node: NODE_C,
                context: [[WRITER_LOCAL, '4']],
                basis: [{ node: NODE_B, value: WRITER_LOCAL + ':3' }],
                });
            const outcome = outcomeOf(synchronize({
                receiver: receiverChain(),
                source: peerAddsC,
                authorityPhysical: 400,
            }));

            const target = db.schemaStorageForReplica(db.otherReplicaName());
            await publishSyncOutcome({ target, outcome });

            for (const occurrence of outcome.projection.occurrences) {
                const identifier = occurrence.nodeIdentifier;
                await expect(target.values.get(identifier)).resolves.toEqual(occurrence.payload);
                await expect(target.freshness.get(identifier)).resolves.toBe(
                    occurrence.fresh ? 'up-to-date' : 'potentially-outdated'
                );
                await expect(target.timestamps.get(identifier)).resolves.toEqual({
                    createdAt: occurrence.createdAt,
                    modifiedAt: occurrence.modifiedAt,
                });
            }
        } finally {
            await db.close();
        }
    });

    test('a stale occurrence lowers to potentially-outdated', async () => {
        const capabilities = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            // A is materialized without a proof, so neither it nor its dependent
            // B is fresh; the lowering must say so rather than default to fresh.
            const receiver = [
                materializeOnly({
                    writer: WRITER_LOCAL,
                    sequence: '1',
                    node: NODE_A,
                    context: [],
                }),
                ...materialize({
                    writer: WRITER_LOCAL,
                    sequence: '2',
                    node: NODE_B,
                    context: [],
                    basis: [{ node: NODE_A, value: WRITER_LOCAL + ':1' }],
                }),
            ];
            const outcome = outcomeOf(synchronize({
                receiver,
                source: [],
                authorityPhysical: 400,
            }));
            expect(outcome.projection.occurrences.map((occurrence) => occurrence.fresh))
                .toEqual([false, false]);

            const target = db.schemaStorageForReplica(db.otherReplicaName());
            await publishSyncOutcome({ target, outcome });

            for (const occurrence of outcome.projection.occurrences) {
                await expect(target.freshness.get(occurrence.nodeIdentifier)).resolves.toBe(
                    'potentially-outdated'
                );
            }
        } finally {
            await db.close();
        }
    });

    test('valid holds each dependency the dependents which proved against it', async () => {
        const capabilities = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            const peerAddsC = materialize({
                writer: WRITER_PEER,
                sequence: '1',
                node: NODE_C,
                context: [[WRITER_LOCAL, '4']],
                basis: [{ node: NODE_B, value: WRITER_LOCAL + ':3' }],
                });
            const outcome = outcomeOf(synchronize({
                receiver: receiverChain(),
                source: peerAddsC,
                authorityPhysical: 400,
            }));

            const target = db.schemaStorageForReplica(db.otherReplicaName());
            await publishSyncOutcome({ target, outcome });

            /** @type {Map<object, Array<string>>} */
            const expected = new Map();
            for (const occurrence of outcome.projection.occurrences) {
                for (const input of occurrence.validInputs) {
                    const dependency = outcome.projection.occurrences.find(
                        (candidate) => candidate.nodeKeyString === input
                    );
                    const list = expected.get(dependency.nodeIdentifier) ?? [];
                    list.push(nodeIdentifierToString(occurrence.nodeIdentifier));
                    expected.set(dependency.nodeIdentifier, list);
                }
            }
            expect(expected.size).toBeGreaterThan(0);
            for (const [dependency, dependents] of expected) {
                await expect(target.valid.get(dependency)).resolves.toEqual(dependents);
            }
        } finally {
            await db.close();
        }
    });

    test('identifiers_keys_map and last_node_index are the committed-pair members the projection implies', async () => {
        const capabilities = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            const outcome = outcomeOf(synchronize({
                receiver: receiverChain(),
                source: materialize({
                    writer: WRITER_PEER,
                    sequence: '1',
                    node: NODE_C,
                    context: [[WRITER_LOCAL, '4']],
                    basis: [{ node: NODE_B, value: WRITER_LOCAL + ':3' }],
                        }),
                authorityPhysical: 400,
            }));

            const target = db.schemaStorageForReplica(db.otherReplicaName());
            await publishSyncOutcome({ target, outcome });

            await expect(target.global.get(IDENTIFIERS_KEY)).resolves.toEqual(
                outcome.projection.occurrences.map((occurrence) => [
                    nodeIdentifierToString(occurrence.nodeIdentifier),
                    occurrence.nodeKeyString,
                ])
            );
            await expect(target.global.get(LAST_NODE_INDEX_KEY)).resolves.toBe(
                outcome.projection.lastNodeIndex
            );
        } finally {
            await db.close();
        }
    });

    test('the operation\'s own records, the occurrence index and the committed-pair metadata land together', async () => {
        const capabilities = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            const peerAddsC = materialize({
                writer: WRITER_PEER,
                sequence: '1',
                node: NODE_C,
                context: [[WRITER_LOCAL, '4']],
                basis: [{ node: NODE_B, value: WRITER_LOCAL + ':3' }],
                });
            const outcome = outcomeOf(synchronize({
                receiver: receiverChain(),
                source: peerAddsC,
                authorityPhysical: 400,
            }));

            const target = db.schemaStorageForReplica(db.otherReplicaName());
            await publishSyncOutcome({ target, outcome });

            for (const record of outcome.records) {
                const key = stringToJournalKey(
                    'record|' + journalAuthorToString(record.id.author) + '|' +
                    journalSequenceToString(record.id.sequence).padStart(30, '0')
                );
                const stored = await target.journal.get(key);
                expect(stored).toBeDefined();
            }
            for (const occurrence of outcome.projection.occurrences) {
                await expect(
                    readCurrentOccurrence(target.journal, occurrence.nodeKey)
                ).resolves.toEqual(occurrence.valueId);
            }
            const stateText = journalTextToString(
                await target.journal.get(stringToJournalKey('state'))
            );
            expect(stateText).toBe(
                JSON.stringify(serializeWriterState(outcome.publication.writerState))
            );
            expect(JSON.parse(stateText).localWriter).toBe(
                journalAuthorToString(outcome.publication.writerState.localWriter)
            );
        } finally {
            await db.close();
        }
    });

    test('a key the projection no longer contains is deleted in the same write', async () => {
        const capabilities = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            const inactive = db.otherReplicaName();
            const seeded = db.schemaStorageForReplica(inactive);
            const doomed = JSON.parse(KEY_C).args[0].id + '-' + db.getFingerprint();
            await seeded.values.put(doomed, PAYLOAD);
            await seeded.freshness.put(doomed, 'up-to-date');
            await seeded.timestamps.put(doomed, { createdAt: NOW, modifiedAt: LATER });
            await seeded.valid.put(doomed, [doomed]);

            const peerDeletesC = deletionOf({
                writer: WRITER_PEER,
                sequence: '1',
                node: NODE_C,
                context: [[WRITER_LOCAL, '4']],
            });
            const outcome = outcomeOf(synchronize({
                receiver: receiverChain(),
                source: [peerDeletesC],
                authorityPhysical: 400,
            }));
            expect(outcome.projection.occurrences.map((occurrence) => occurrence.nodeKeyString))
                .toEqual([KEY_A, KEY_B]);

            await publishSyncOutcome({ target: seeded, outcome });

            await expect(seeded.values.get(doomed)).resolves.toBeUndefined();
            await expect(seeded.freshness.get(doomed)).resolves.toBeUndefined();
            await expect(seeded.timestamps.get(doomed)).resolves.toBeUndefined();
            await expect(seeded.valid.get(doomed)).resolves.toBeUndefined();
        } finally {
            await db.close();
        }
    });

    test('the whole lowering is one batch call', async () => {
        const capabilities = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            const outcome = outcomeOf(synchronize({
                receiver: receiverChain(),
                source: materialize({
                    writer: WRITER_PEER,
                    sequence: '1',
                    node: NODE_C,
                    context: [[WRITER_LOCAL, '4']],
                    basis: [{ node: NODE_B, value: WRITER_LOCAL + ':3' }],
                        }),
                authorityPhysical: 400,
            }));
            const target = db.schemaStorageForReplica(db.otherReplicaName());
            const operations = await planSyncPublication({ target, outcome });
            expect(operations.length).toBeGreaterThan(0);

            /** @type {Array<Array<*>>} */
            const batches = [];
            const delegate = target.batch;
            target.batch = async (written) => {
                batches.push(written);
                await delegate(written);
            };
            await publishSyncOutcome({ target, outcome });

            expect(batches).toHaveLength(1);
            expect(batches[0]).toHaveLength(operations.length);
        } finally {
            await db.close();
        }
    });
});

describe('readRetainedLengths', () => {
    /**
     * How many entries a range read yields, which is what distinguishes one range
     * read from a scan of the same keys.
     * @param {AsyncIterable<unknown>} range
     * @returns {Promise<number>}
     */
    async function countEntries(range) {
        let seen = 0;
        for await (const entry of range) {
            if (entry !== undefined) {
                seen += 1;
            }
        }
        return seen;
    }

    /**
     * Seed `count` records under one writer and return how many entries the
     * reverse range read over that writer's keys yields.
     * @param {number} count
     * @returns {Promise<{lengths: unknown, yielded: number}>}
     */
    async function lengthsOverRecordsOf(count) {
        const capabilities = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            const journal = await journalSublevelOf(db);
            for (let index = 1; index <= count; index += 1) {
                await journal.put(
                    stringToJournalKey(
                        'record|' + WRITER_LOCAL + '|' + String(index).padStart(30, '0')
                    ),
                    stringToJournalText('{}')
                );
            }
            const lengths = await readRetainedLengths(journal);
            expect(lengths instanceof Error).toBe(false);
            const range = journal.iterator({
                gte: stringToJournalKey('record|' + WRITER_LOCAL + '|'),
                lte: stringToJournalKey('record|' + WRITER_LOCAL + '|￿'),
                reverse: true,
                limit: 1,
            });
            const yielded = await countEntries(range);
            return { lengths, yielded };
        } finally {
            await db.close();
        }
    }

    test('a writer\'s retained length is its greatest retained coordinate', async () => {
        const { lengths } = await lengthsOverRecordsOf(7);
        expect(retainedLengthTexts(lengths)).toEqual([[WRITER_LOCAL, '7']]);
    });

    test('the answer costs one range read, not one read per retained record', async () => {
        const few = await lengthsOverRecordsOf(2);
        const many = await lengthsOverRecordsOf(200);
        expect(few.yielded).toBe(1);
        expect(many.yielded).toBe(1);
        expect(retainedLengthTexts(many.lengths)).toEqual([[WRITER_LOCAL, '200']]);
    });
});

describe('the synchronization staging surface carries no transport locator', () => {
    test('no persisted sublevel name or key names the configured hostname or the _h_ prefix', async () => {
        const capabilities = makeTestCapabilities();
        expect(capabilities.environment.hostname()).toBe(TEST_HOSTNAME);
        const db = await getRootDatabase(capabilities);
        try {
            const outcome = outcomeOf(synchronize({
                receiver: receiverChain(),
                source: materialize({
                    writer: WRITER_PEER,
                    sequence: '1',
                    node: NODE_C,
                    context: [[WRITER_LOCAL, '4']],
                    basis: [{ node: NODE_B, value: WRITER_LOCAL + ':3' }],
                        }),
                authorityPhysical: 400,
            }));

            const staging = syncStagingStorage(db.db);
            await publishSyncOutcome({ target: staging, outcome });

            const duringStaging = await everyPersistedKey(db);
            const inactive = db.otherReplicaName();
            await publishSyncOutcome({
                target: db.schemaStorageForReplica(inactive),
                outcome,
            });
            await db.setCurrentReplicaPointer(inactive);
            await clearSyncStaging(db.db);
            const afterCutover = await everyPersistedKey(db);

            for (const phase of [['during staging', duringStaging], ['after cutover', afterCutover]]) {
                for (const key of phase[1]) {
                    expect(key.includes(TEST_HOSTNAME)).toBe(false);
                    expect(key.includes('_h_')).toBe(false);
                }
                for (const name of SYNC_STAGING_PERSISTED_NAMES) {
                    expect(name.includes(TEST_HOSTNAME)).toBe(false);
                    expect(name.includes('_h_')).toBe(false);
                }
            }
        } finally {
            await db.close();
        }
    });

    test('the staging sublevel holds the outcome, and clearing it removes only inactive state', async () => {
        const capabilities = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            const outcome = outcomeOf(synchronize({
                receiver: receiverChain(),
                source: materialize({
                    writer: WRITER_PEER,
                    sequence: '1',
                    node: NODE_C,
                    context: [[WRITER_LOCAL, '4']],
                    basis: [{ node: NODE_B, value: WRITER_LOCAL + ':3' }],
                        }),
                authorityPhysical: 400,
            }));

            const staging = syncStagingStorage(db.db);
            await publishSyncOutcome({ target: staging, outcome });
            expect((await everyPersistedKey(db)).some((key) => key.startsWith('!sync_staging!')))
                .toBe(true);

            await clearSyncStaging(db.db);
            expect((await everyPersistedKey(db)).some((key) => key.startsWith('!sync_staging!')))
                .toBe(false);
        } finally {
            await db.close();
        }
    });
});

describe('the published journal reads back as the operation retained it', () => {
    test('every published record decodes to the record it was written from', async () => {
        const capabilities = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            const outcome = outcomeOf(synchronize({
                receiver: receiverChain(),
                source: materialize({
                    writer: WRITER_PEER,
                    sequence: '1',
                    node: NODE_C,
                    context: [[WRITER_LOCAL, '4']],
                    basis: [{ node: NODE_B, value: WRITER_LOCAL + ':3' }],
                        }),
                authorityPhysical: 400,
            }));
            const staging = syncStagingStorage(db.db);
            await publishSyncOutcome({ target: staging, outcome });

            /** @type {Array<string>} */
            const stored = [];
            for await (const key of staging.journal.keys()) {
                const text = journalKeyToString(key);
                if (!text.startsWith('record|')) {
                    continue;
                }
                stored.push(journalTextToString(await staging.journal.get(key)));
            }
            expect(stored).toHaveLength(outcome.records.length);
            expect(stored.map((text) => JSON.parse(text).id).sort()).toEqual(
                outcome.records.map((record) => journalRecordIdToString(record.id)).sort()
            );
        } finally {
            await db.close();
        }
    });
});
