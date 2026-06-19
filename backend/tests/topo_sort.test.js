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
    nodeIdentifierFromString,
    GRAPH_SCHEME_KEY,
    IDENTIFIERS_KEY,
} = require('../src/generators/incremental_graph/database');
const {
    topologicalSort,
    topologicalSortFromMap,
    TopologicalSortCycleError,
    isTopologicalSortCycleError,
} = require('../src/generators/incremental_graph/database/topo_sort');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');
const { toJsonKey } = require('./test_json_key_helper');

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
 * Return a stable current-format NodeIdentifier for test index i (0-25).
 * Uses a base36 index and a fixed test fingerprint.
 * @param {number} i
 * @returns {import('../src/generators/incremental_graph/database/types').NodeIdentifier}
 */
function makeTestId(i) {
    return nodeIdentifierFromString(`${i.toString(36)}-abcdefghi`);
}

// Named constants for the most commonly used test node identifiers.
const NODE_A = makeTestId(0);  // '1-abcdefghi'
const NODE_B = makeTestId(1);  // '2-abcdefghi'
const NODE_C = makeTestId(2);  // '3-abcdefghi'
const NODE_D = makeTestId(3);  // 'ddddddddd'
const NODE_E = makeTestId(4);  // 'eeeeeeeee'  (used as external/unlisted node)
const NODE_M = makeTestId(12); // 'mmmmmmmmm'
const NODE_Z = makeTestId(25); // 'z-abcdefghi'

const LINEAR_CHAIN_SCHEME = {
    format: 1,
    nodes: [
        { head: "A", arity: 0, inputTemplates: [] },
        { head: "B", arity: 0, inputTemplates: [{ head: "A", args: [] }] },
        { head: "C", arity: 0, inputTemplates: [{ head: "B", args: [] }] },
    ],
};

/**
 * Write the graph scheme and identity lookup for the A -> B -> C test graph.
 * @param {import('../src/generators/incremental_graph/database').SchemaStorage} storage
 * @param {Array<[string, string]>} entries
 * @returns {Promise<void>}
 */
async function writeLinearChainMetadata(storage, entries) {
    await storage.global.put(GRAPH_SCHEME_KEY, JSON.stringify(LINEAR_CHAIN_SCHEME));
    await storage.global.put(IDENTIFIERS_KEY, entries);
}

/**
 * Write materialized values in the requested order.
 * @param {import('../src/generators/incremental_graph/database').SchemaStorage} storage
 * @param {string[]} identifiers
 * @returns {Promise<void>}
 */
async function writeValues(storage, identifiers) {
    for (const identifier of identifiers) {
        await storage.values.put(identifier, { value: identifier });
    }
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

    test('orders storage-level linear chain A -> B -> C from graph_scheme', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const storage = db.getSchemaStorage();
            const idA = NODE_A, idB = NODE_B, idC = NODE_C;
            await writeLinearChainMetadata(storage, [
                [idA, toJsonKey('A')],
                [idB, toJsonKey('B')],
                [idC, toJsonKey('C')],
            ]);
            await writeValues(storage, [idA, idB, idC]);

            expect(await topologicalSort(storage)).toEqual([idA, idB, idC]);
        } finally {
            if (db) await db.close();
        }
    });

    test('storage-level sort fails when graph_scheme is missing', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const storage = db.getSchemaStorage();
            await storage.global.put(IDENTIFIERS_KEY, [[NODE_A, toJsonKey('A')]]);
            await writeValues(storage, [NODE_A]);

            await expect(topologicalSort(storage)).rejects.toThrow(/graph_scheme/);
        } finally {
            if (db) await db.close();
        }
    });

    test('storage-level sort fails when identifiers_keys_map is missing', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const storage = db.getSchemaStorage();
            await storage.global.put(GRAPH_SCHEME_KEY, JSON.stringify(LINEAR_CHAIN_SCHEME));
            await storage.global.del(IDENTIFIERS_KEY);
            await writeValues(storage, [NODE_A]);

            await expect(topologicalSort(storage)).rejects.toThrow(/identifiers_keys_map/);
        } finally {
            if (db) await db.close();
        }
    });

    test('storage-level sort follows scheme dependencies instead of insertion order', async () => {
        const capabilities = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(capabilities);
            const storage = db.getSchemaStorage();
            const idA = NODE_A, idB = NODE_B, idC = NODE_C;
            await writeLinearChainMetadata(storage, [
                [idA, toJsonKey('A')],
                [idB, toJsonKey('B')],
                [idC, toJsonKey('C')],
            ]);
            await writeValues(storage, [idC, idB, idA]);

            expect(await topologicalSort(storage)).toEqual([idA, idB, idC]);
        } finally {
            if (db) await db.close();
        }
    });

    test('returns a single node for a single-node graph', async () => {
        const nodeA = NODE_A;
        const map = new Map([[nodeA, []]]);
        const result = topologicalSortFromMap(map);
        expect(result).toEqual([nodeA]);
    });

    test('orders a linear chain A → B → C correctly (A first)', async () => {
        const nodeA = NODE_A;
        const nodeB = NODE_B;
        const nodeC = NODE_C;
        // B depends on A, C depends on B.
        const map = new Map([
            [nodeA, []],
            [nodeB, [nodeA]],
            [nodeC, [nodeB]],
        ]);
        const result = topologicalSortFromMap(map);
        expect(result).toEqual([nodeA, nodeB, nodeC]);
    });

    test('handles diamond dependency A → {B,C} → D', async () => {
        const nodeA = NODE_A;
        const nodeB = NODE_B;
        const nodeC = NODE_C;
        const nodeD = NODE_D;
        // B and C both depend on A; D depends on both B and C.
        const map = new Map([
            [nodeA, []],
            [nodeB, [nodeA]],
            [nodeC, [nodeA]],
            [nodeD, [nodeB, nodeC]],
        ]);
        const result = topologicalSortFromMap(map);
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
    });

    test('nodes at the same depth are sorted by NodeKeyString ascending (stability)', async () => {
        // Three independent root nodes; they should appear in ascending key order.
        const nodeZ = NODE_Z;
        const nodeA = NODE_A;
        const nodeM = NODE_M;
        const map = new Map([
            [nodeZ, []],
            [nodeA, []],
            [nodeM, []],
        ]);
        const result = topologicalSortFromMap(map);
        expect(result.length).toBe(3);
        // Result must be sorted ascending by key string.
        const sorted = [...result].sort();
        expect(result).toEqual(sorted);
    });

    test('throws TopologicalSortCycleError when the graph has a cycle', async () => {
        const nodeA = NODE_A;
        const nodeB = NODE_B;
        // A → B and B → A form a cycle.
        const map = new Map([
            [nodeA, [nodeB]],
            [nodeB, [nodeA]],
        ]);
        expect(() => topologicalSortFromMap(map)).toThrow(TopologicalSortCycleError);
    });

    test('isTopologicalSortCycleError identifies the error correctly', async () => {
        const nodeA = NODE_A;
        const nodeB = NODE_B;
        const map = new Map([
            [nodeA, [nodeB]],
            [nodeB, [nodeA]],
        ]);
        let caught;
        try {
            topologicalSortFromMap(map);
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeDefined();
        expect(isTopologicalSortCycleError(caught)).toBe(true);
        expect(isTopologicalSortCycleError(new Error('other'))).toBe(false);
    });
});

describe('topologicalSortFromMap', () => {
    /**
     * Build a NodeKeyString→NodeKeyString[] map from a plain object for test convenience.
     * @param {Record<string, string[]>} obj
     * @returns {Map<string, string[]>}
     */
    function makeMap(obj) {
        return new Map(Object.entries(obj));
    }

    test('returns empty array for an empty map', () => {
        expect(topologicalSortFromMap(new Map())).toEqual([]);
    });

    test('orders A → B → C correctly', () => {
        const nodeA = NODE_A;
        const nodeB = NODE_B;
        const nodeC = NODE_C;
        const map = makeMap({ [nodeA]: [], [nodeB]: [nodeA], [nodeC]: [nodeB] });
        expect(topologicalSortFromMap(map)).toEqual([nodeA, nodeB, nodeC]);
    });

    test('detects a cycle among in-map nodes', () => {
        const nodeA = NODE_A;
        const nodeB = NODE_B;
        const map = makeMap({ [nodeA]: [nodeB], [nodeB]: [nodeA] });
        expect(() => topologicalSortFromMap(map)).toThrow(TopologicalSortCycleError);
    });

    test('cycle error message is size-bounded while retaining full cycle payload', () => {
        /** @type {Record<string, string[]>} */
        const obj = {};
        const nodes = [];
        for (let i = 0; i < 25; i += 1) {
            nodes.push(makeTestId(i));
        }
        for (let i = 0; i < nodes.length; i += 1) {
            obj[nodes[i]] = [nodes[(i + 1) % nodes.length]];
        }

        let caught;
        try {
            topologicalSortFromMap(makeMap(obj));
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(TopologicalSortCycleError);
        if (!(caught instanceof TopologicalSortCycleError)) {
            throw new Error('expected TopologicalSortCycleError');
        }
        expect(caught.cycle.length).toBe(25);
        expect(caught.message).toContain('involving 25 nodes');
        expect(caught.message).toContain('... (+5 more)');
    });

    test('ignores edges to nodes not present in the map', () => {
        const nodeA = NODE_A;
        const nodeB = NODE_B;
        const external = NODE_E;
        // nodeB "depends" on external which is not in the map — treated as root.
        const map = makeMap({ [nodeA]: [], [nodeB]: [external] });
        const result = topologicalSortFromMap(map);
        expect(result.length).toBe(2);
        expect(result).toContain(nodeA);
        expect(result).toContain(nodeB);
    });
});
