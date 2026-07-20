/**
 * Real-database integration test for migration pull behavior.
 *
 * Uses the canonical production RootDatabase, exercises real replica
 * cutover, and verifies post-migration pull semantics.
 *
 * checkpointMigration is mocked to avoid requiring git infrastructure,
 * but the migration callback and replica cutover use the real database.
 */

const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
const {
    getRootDatabase,
    GRAPH_SCHEME_KEY,
} = require("../src/generators/incremental_graph/database");
const {
    createIncrementalGraph,
    makeUnchanged,
} = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubDatetime, stubEnvironment } = require("./stubs");

// Mock checkpointMigration to avoid requiring git infrastructure
jest.mock('../src/generators/incremental_graph/database', () => ({
    ...jest.requireActual('../src/generators/incremental_graph/database'),
    checkpointMigration: jest.fn(),
}));
const { checkpointMigration: mockCheckpointMigration } = require('../src/generators/incremental_graph/database');

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubEnvironment(capabilities);
    return capabilities;
}

describe("migration integration", () => {
    beforeEach(() => {
        mockCheckpointMigration.mockReset();
        mockCheckpointMigration.mockImplementation(
            async (_caps, _db, _pre, _post, callback) => await callback()
        );
    });

    test("explicit B root removes A→B, preserves B→C, C cache-revalidates; durable cutover", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const appVersion = db.getVersion();

            let aCalls = 0, bCalls = 0, cCalls = 0;
            const nodeDefs = [
                { output: "A", inputs: [], computor: async () => { aCalls++; return ({ v: 1 }); }, isDeterministic: true, hasSideEffects: false },
                { output: "B", inputs: ["A"], computor: async (_inputs, oldValue) => { bCalls++; if (oldValue === undefined) return ({ v: 2 }); return makeUnchanged(); }, isDeterministic: true, hasSideEffects: false },
                { output: "C", inputs: ["B"], computor: async () => { cCalls++; return ({ v: 3 }); }, isDeterministic: true, hasSideEffects: false },
            ];
            const expectedScheme = JSON.stringify({
                format: 1,
                nodes: [
                    { head: "A", arity: 0, inputTemplates: [] },
                    { head: "B", arity: 0, inputTemplates: [{ head: "A", args: [] }] },
                    { head: "C", arity: 0, inputTemplates: [{ head: "B", args: [] }] },
                ],
            });

            // --- Phase 1: Build version-1 source ---
            const g1 = await createIncrementalGraph(caps, db, nodeDefs);
            await g1.pull("C");
            expect(bCalls).toBe(1);
            expect(cCalls).toBe(1);

            const activeBefore = db.currentReplicaName();
            const storageBefore = db.getSchemaStorage();
            await storageBefore.global.put("version", "1");
            await db.close();

            // --- Phase 2: Reopen and migrate ---
            db = await getRootDatabase(caps);
            await runMigration(caps, db, nodeDefs, async (storage) => {
                for await (const nk of storage.listMaterializedNodes()) {
                    const key = await storage.resolveNodeKey(nk);
                    if (!key) continue;
                    if (String(key.head) === "A") {
                        await storage.keep(nk);
                    } else if (String(key.head) === "B") {
                        await storage.invalidate(nk);
                    }
                }
            });

            // --- Phase 3: Prove in-memory cutover ---
            const activeAfter = db.currentReplicaName();
            expect(activeAfter).not.toBe(activeBefore);
            expect(db.otherReplicaName()).toBe(activeBefore);

            // --- Phase 4: Prove durable cutover (reopen) ---
            await db.close();
            db = await getRootDatabase(caps);
            expect(db.currentReplicaName()).toBe(activeAfter);
            expect(db.otherReplicaName()).toBe(activeBefore);

            // --- Phase 5: Verify post-migration persisted state ---
            const storage = db.getSchemaStorage();
            const lookup = db.getActiveIdentifierLookup();
            const aId = lookup.keyToId.get('{"head":"A","args":[]}');
            const bId = lookup.keyToId.get('{"head":"B","args":[]}');
            const cId = lookup.keyToId.get('{"head":"C","args":[]}');
            expect(aId).toBeDefined();
            expect(bId).toBeDefined();
            expect(cId).toBeDefined();

            expect(await storage.freshness.get(aId)).toBe("up-to-date");
            expect(await storage.freshness.get(bId)).toBe("potentially-outdated");
            expect(await storage.freshness.get(cId)).toBe("potentially-outdated");

            const validA = await storage.valid.get(aId) ?? [];
            const validB = await storage.valid.get(bId) ?? [];
            expect(validA.some(d => String(d) === String(bId))).toBe(false);
            expect(validB.some(d => String(d) === String(cId))).toBe(true);

            expect(await storage.global.get("version")).toBe(appVersion);
            expect(await storage.global.get(GRAPH_SCHEME_KEY)).toBe(expectedScheme);

            // --- Phase 6: Open graph and pull C ---
            aCalls = 0; bCalls = 0; cCalls = 0;
            const g2 = await createIncrementalGraph(caps, db, nodeDefs);
            const result = await g2.pull("C");
            expect(aCalls).toBe(0);
            expect(bCalls).toBe(1);
            expect(cCalls).toBe(0);
            expect(result).toEqual({ v: 3 });

            // --- Phase 7: Final state ---
            expect(await g2.getFreshness("A")).toBe("up-to-date");
            expect(await g2.getFreshness("B")).toBe("up-to-date");
            expect(await g2.getFreshness("C")).toBe("up-to-date");

            const validAFinal = await storage.valid.get(aId) ?? [];
            const validBFinal = await storage.valid.get(bId) ?? [];
            expect(validAFinal.some(d => String(d) === String(bId))).toBe(true);
            expect(validBFinal.some(d => String(d) === String(cId))).toBe(true);
        } finally {
            if (db) await db.close();
        }
    });
});
