/**
 * End-to-end publication tests for the joinable identifier reservation.
 *
 * Two live operations which need the same fresh node key share one identifier:
 * the first to need the key reserves it, the second joins that reservation rather
 * than minting a second identifier for the same key. What the joining operation
 * then publishes under the shared identifier is a question about publication
 * order, and the reservation unit tests cannot answer it: they drive the
 * reservation directly and never publish anything.
 *
 * These tests drive the real graph over the real root database and pin the two
 * orderings which decide what the shared node carries:
 *
 * - the operation which took the reservation commits before the operation which
 *   joined it, so the joiner's write is the one that survives;
 * - the operation which took the reservation rolls back, so its uncommitted write
 *   is discarded and only the joiner's is durable.
 *
 * In both orderings the shared key must end up with exactly one mapping. The
 * rollback ordering additionally pins that the rolled-back operation gave up its
 * own hold and left the reservation standing for the operation which had joined
 * it: a third operation which needs the same fresh key after the rollback, while
 * the joiner is still running, must still find that reservation rather than mint
 * a second identifier for the key.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createIncrementalGraph } = require('../src/generators/incremental_graph');
const {
    getRootDatabase,
    makeIdentifierLookup,
    IDENTIFIERS_KEY,
} = require('../src/generators/incremental_graph/database');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');
const { numberComputedValue } = require('./computed_value_fixture');

/**
 * @typedef {import('../src/generators/incremental_graph/database/types').NodeIdentifier} NodeIdentifier
 * @typedef {import('../src/generators/incremental_graph/database/types').NodeKeyString} NodeKeyString
 * @typedef {import('../src/generators/incremental_graph/database/types').ComputedValue} ComputedValue
 * @typedef {import('../src/generators/incremental_graph/database/types').RootDatabase} RootDatabase
 */

const KEY_Z = JSON.stringify({ head: 'z', args: [] });

/**
 * @returns {{ promise: Promise<unknown>, resolve: (value?: unknown) => void }}
 */
function makeDeferred() {
    /** @type {(value?: unknown) => void} */
    let resolve = () => {};
    const promise = new Promise((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

/**
 * @returns {import('../src/generators/incremental_graph/database/types').DatabaseCapabilities & {tmpDir: string}}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reservation-publication-'));
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return { ...capabilities, tmpDir };
}

/**
 * @param {string} tmpDir
 */
function cleanup(tmpDir) {
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

/**
 * The persisted identifier table, which is the durable record of which key owns
 * which identifier. It is the only place a second identifier for one key could
 * become visible.
 * @param {RootDatabase} db
 * @returns {Promise<Array<[NodeIdentifier, NodeKeyString]>>}
 */
async function readPersistedLookup(db) {
    return await db.getSchemaStorage().global.get(IDENTIFIERS_KEY);
}

/**
 * The number of persisted mappings which name the given key. More than one means
 * two identifiers were minted for one key.
 * @param {Array<[NodeIdentifier, NodeKeyString]>} persisted
 * @param {string} key
 * @returns {number}
 */
function countMappingsFor(persisted, key) {
    return persisted.filter(([, nodeKey]) => nodeKey === key).length;
}

/**
 * The committed value of the node the key names.
 * @param {Array<[NodeIdentifier, NodeKeyString]>} persisted
 * @param {string} key
 * @param {RootDatabase} db
 * @returns {Promise<ComputedValue | undefined>}
 */
async function readCommittedValue(persisted, key, db) {
    const lookup = makeIdentifierLookup(persisted);
    const identifier = lookup.keyToId.get(key);
    if (identifier === undefined) {
        throw new Error(`no committed identifier for key ${key}`);
    }
    return await db.getSchemaStorage().values.get(identifier);
}

describe('joined reservation publication', () => {
    test('the operation which joins a reservation and commits second is the value the shared node carries', async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getRootDatabase(capabilities);

            const bothEntered = makeDeferred();
            const firstCommitted = makeDeferred();
            let entered = 0;
            let nextZValue = 0;
            let commits = 0;
            let firstZValue = 0;
            let secondZValue = 0;

            /**
             * @param {number} zValue
             */
            const bothHaveEntered = () => {
                entered += 1;
                if (entered === 2) {
                    bothEntered.resolve();
                }
                return bothEntered.promise;
            };

            const graph = await createIncrementalGraph(capabilities, db, [
                {
                    output: 'z',
                    inputs: [],
                    computor: async () => {
                        const value = nextZValue;
                        nextZValue += 1;
                        return numberComputedValue(value);
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
                {
                    output: 'x',
                    inputs: ['z'],
                    computor: async ([zValue]) => {
                        firstZValue = zValue.value;
                        await bothHaveEntered();
                        return numberComputedValue(firstZValue);
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
                {
                    output: 'y',
                    inputs: ['z'],
                    computor: async ([zValue]) => {
                        secondZValue = zValue.value;
                        await bothHaveEntered();
                        // The joiner returns from its computor only once the operation
                        // which took the reservation has committed, so the commit order
                        // is decided rather than raced.
                        await firstCommitted.promise;
                        return numberComputedValue(secondZValue);
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
            ]);

            const originalWithUserOperation = graph.storage.withUserOperation.bind(graph.storage);
            graph.storage.withUserOperation = async (fn) => {
                const result = await originalWithUserOperation(fn);
                commits += 1;
                if (commits === 1) {
                    firstCommitted.resolve();
                }
                return result;
            };

            await Promise.all([graph.pull('x'), graph.pull('y')]);

            // The two operations computed the shared node's value independently, so
            // "the value the shared node carries" names exactly one of them.
            expect(firstZValue).not.toBe(secondZValue);

            const persisted = await readPersistedLookup(db);
            expect(countMappingsFor(persisted, KEY_Z)).toBe(1);
            expect(() => makeIdentifierLookup(persisted)).not.toThrow();

            // The joiner committed second, so the shared node carries the joiner's
            // value and not the value the operation which took the reservation wrote.
            const committed = await readCommittedValue(persisted, KEY_Z, db);
            expect(committed).toEqual(numberComputedValue(secondZValue));

            await db.close();
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test('the operation which joins a reservation survives the rollback of the operation which took it', async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getRootDatabase(capabilities);

            const bothEntered = makeDeferred();
            const thirdEntered = makeDeferred();
            const secondCommitted = makeDeferred();
            let entered = 0;
            let nextZValue = 0;
            let commits = 0;
            let abandonedZValue = 0;
            let survivorZValue = 0;

            const graph = await createIncrementalGraph(capabilities, db, [
                {
                    output: 'z',
                    inputs: [],
                    computor: async () => {
                        const value = nextZValue;
                        nextZValue += 1;
                        return numberComputedValue(value);
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
                {
                    output: 'x',
                    inputs: ['z'],
                    computor: async ([zValue]) => {
                        abandonedZValue = zValue.value;
                        entered += 1;
                        if (entered === 2) {
                            bothEntered.resolve();
                        }
                        await bothEntered.promise;
                        throw new Error('abandoned operation');
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
                {
                    output: 'y',
                    inputs: ['z'],
                    computor: async ([zValue]) => {
                        survivorZValue = zValue.value;
                        entered += 1;
                        if (entered === 2) {
                            bothEntered.resolve();
                        }
                        await bothEntered.promise;
                        // The joiner stays alive until a third operation has needed the
                        // same fresh key, and commits only after that operation has
                        // committed, so the rollback ordering and the third operation's
                        // allocation are both decided rather than raced.
                        await thirdEntered.promise;
                        await secondCommitted.promise;
                        return numberComputedValue(survivorZValue);
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
                {
                    output: 't',
                    inputs: ['z'],
                    computor: async ([zValue]) => {
                        thirdEntered.resolve();
                        return numberComputedValue(zValue.value);
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
            ]);

            const originalWithUserOperation = graph.storage.withUserOperation.bind(graph.storage);
            graph.storage.withUserOperation = async (fn) => {
                const result = await originalWithUserOperation(fn);
                commits += 1;
                if (commits === 1) {
                    secondCommitted.resolve();
                }
                return result;
            };

            const abandoned = graph.pull('x');
            const survivor = graph.pull('y');
            await expect(abandoned).rejects.toThrow('abandoned operation');

            // The third operation needs the same fresh key after the rolled-back
            // operation gave up its hold and while the joiner is still running. A
            // release which dropped the reservation instead of decrementing it would
            // let this operation mint a second identifier for the key.
            const third = graph.pull('t');
            await Promise.all([survivor, third]);

            expect(abandonedZValue).not.toBe(survivorZValue);

            const persisted = await readPersistedLookup(db);
            expect(countMappingsFor(persisted, KEY_Z)).toBe(1);
            expect(() => makeIdentifierLookup(persisted)).not.toThrow();

            // The rolled-back operation's write is discarded with its batch, so the
            // shared node carries the value the joiner computed.
            const committed = await readCommittedValue(persisted, KEY_Z, db);
            expect(committed).toEqual(numberComputedValue(survivorZValue));

            // Nothing leaked: once every operation has ended, no reservation and no
            // reverse entry for one is left behind.
            expect(db._pendingAllocations.has(KEY_Z)).toBe(false);
            expect(db._pendingAllocationsById.size).toBe(0);

            await db.close();
        } finally {
            cleanup(capabilities.tmpDir);
        }
    }, 20000);
});
