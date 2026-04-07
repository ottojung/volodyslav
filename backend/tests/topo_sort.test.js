/**
 * Unit tests for the stable topological sort utility.
 *
 * Tests cover:
 *   - empty graph
 *   - single node
 *   - linear chain A → B → C
 *   - diamond A → {B,C} → D
 *   - stability: nodes at the same depth are ordered by NodeKeyString ascending
 *   - cycle detection: TopologicalSortCycleError is thrown
 */

const {
    getRootDatabase,
} = require('../src/generators/incremental_graph/database');
const {
    topologicalSort,
    TopologicalSortCycleError,
    isTopologicalSortCycleError,
} = require('../src/generators/incremental_graph/database/topo_sort');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

jest.setTimeout(15000);

/**
 * Build test capabilities backed by the temp directories created by
 * `stubEnvironment`.  No additional temp directory is needed because
 * `stubEnvironment` already provisions all required paths.
 * @returns {object}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return capabilities;
}

/**
 * Create a node key string for the given node name (head only, no args).
 * @param {string} name
 * @returns {string}
 */
function nk(name) {
    return `{"head":"${name}","args":[]}`;
}

/**
 * Write an inputs record for `node` whose dependencies are `inputs`.
 *
 * @param {object} storage - SchemaStorage instance.
 * @param {string} nodeKey
 * @param {string[]} inputKeys - NodeKeyString array.
 * @returns {Promise<void>}
 */
async function putNode(storage, nodeKey, inputKeys) {
    await storage.inputs.put(nodeKey, { inputs: inputKeys, inputCounters: [] });
}

describe('topologicalSort', () => {
    test('returns empty array for an empty graph', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const storage = db.getSchemaStorage();
            const result = await topologicalSort(storage);
            expect(result).toEqual([]);
        } finally {
            if (db) await db.close();
        }
    });

    test('returns a single node for a single-node graph', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const storage = db.getSchemaStorage();
            const nodeA = nk('alpha');
            await putNode(storage, nodeA, []);
            const result = await topologicalSort(storage);
            expect(result).toEqual([nodeA]);
        } finally {
            if (db) await db.close();
        }
    });

    test('orders a linear chain A → B → C correctly (A first)', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const storage = db.getSchemaStorage();
            const nodeA = nk('a');
            const nodeB = nk('b');
            const nodeC = nk('c');
            // B depends on A, C depends on B.
            await putNode(storage, nodeA, []);
            await putNode(storage, nodeB, [nodeA]);
            await putNode(storage, nodeC, [nodeB]);
            const result = await topologicalSort(storage);
            expect(result).toEqual([nodeA, nodeB, nodeC]);
        } finally {
            if (db) await db.close();
        }
    });

    test('handles diamond dependency A → {B,C} → D', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const storage = db.getSchemaStorage();
            const nodeA = nk('a');
            const nodeB = nk('b');
            const nodeC = nk('c');
            const nodeD = nk('d');
            // B and C both depend on A; D depends on both B and C.
            await putNode(storage, nodeA, []);
            await putNode(storage, nodeB, [nodeA]);
            await putNode(storage, nodeC, [nodeA]);
            await putNode(storage, nodeD, [nodeB, nodeC]);
            const result = await topologicalSort(storage);
            // A must be first; D must be last; B and C between them.
            expect(result[0]).toBe(nodeA);
            expect(result[result.length - 1]).toBe(nodeD);
            // Both B and C must appear before D.
            const idxB = result.indexOf(nodeB);
            const idxC = result.indexOf(nodeC);
            const idxD = result.indexOf(nodeD);
            expect(idxB).toBeGreaterThan(-1);
            expect(idxC).toBeGreaterThan(-1);
            expect(idxB).toBeLessThan(idxD);
            expect(idxC).toBeLessThan(idxD);
        } finally {
            if (db) await db.close();
        }
    });

    test('nodes at the same depth are sorted by NodeKeyString ascending (stability)', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const storage = db.getSchemaStorage();
            // Three independent root nodes; they should appear in ascending key order.
            const nodeZ = nk('zed');
            const nodeA = nk('aaa');
            const nodeM = nk('mid');
            await putNode(storage, nodeZ, []);
            await putNode(storage, nodeA, []);
            await putNode(storage, nodeM, []);
            const result = await topologicalSort(storage);
            expect(result.length).toBe(3);
            // Result must be sorted ascending by key string.
            const sorted = [...result].sort();
            expect(result).toEqual(sorted);
        } finally {
            if (db) await db.close();
        }
    });

    test('throws TopologicalSortCycleError when the graph has a cycle', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const storage = db.getSchemaStorage();
            const nodeA = nk('a');
            const nodeB = nk('b');
            // A → B and B → A form a cycle.
            await putNode(storage, nodeA, [nodeB]);
            await putNode(storage, nodeB, [nodeA]);
            await expect(topologicalSort(storage)).rejects.toBeInstanceOf(
                TopologicalSortCycleError
            );
        } finally {
            if (db) await db.close();
        }
    });

    test('isTopologicalSortCycleError identifies the error correctly', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const storage = db.getSchemaStorage();
            const nodeA = nk('a');
            const nodeB = nk('b');
            await putNode(storage, nodeA, [nodeB]);
            await putNode(storage, nodeB, [nodeA]);
            let caught;
            try {
                await topologicalSort(storage);
            } catch (err) {
                caught = err;
            }
            expect(caught).toBeDefined();
            expect(isTopologicalSortCycleError(caught)).toBe(true);
            expect(isTopologicalSortCycleError(new Error('other'))).toBe(false);
        } finally {
            if (db) await db.close();
        }
    });
});
