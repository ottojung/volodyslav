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
    IDENTIFIERS_KEY,
    LAST_NODE_INDEX_KEY,
} = require("../src/generators/incremental_graph/database");
const {
    createIncrementalGraph,
    makeUnchanged,
} = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubDatetime, stubEnvironment } = require("./stubs");

// Mock checkpointMigration to avoid git infrastructure
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

    test("explicit B root removes A→B, preserves B→C, C cache-revalidates after pull", async () => {
        // A → B → C. Real RootDatabase, real migration, real pull.
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);

            let aCalls = 0, bCalls = 0, cCalls = 0;
            const nodeDefs = [
                { output: "A", inputs: [], computor: async () => { aCalls++; return ({ v: 1 }); }, isDeterministic: true, hasSideEffects: false },
                { output: "B", inputs: ["A"], computor: async (_inputs, oldValue) => { bCalls++; if (oldValue === undefined) return ({ v: 2 }); return makeUnchanged(); }, isDeterministic: true, hasSideEffects: false },
                { output: "C", inputs: ["B"], computor: async () => { cCalls++; return ({ v: 3 }); }, isDeterministic: true, hasSideEffects: false },
            ];

            // --- Phase 1: Build version-1 source, materialize A→B→C ---
            const g1 = await createIncrementalGraph(caps, db, nodeDefs);
            await g1.pull("C");
            expect(bCalls).toBe(1);
            expect(cCalls).toBe(1);

            // Overwrite version to "1" so migration detects a change
            const activeBefore = db.currentReplicaName();
            const storageBefore = db.getSchemaStorage();
            await storageBefore.global.put("version", "1");
            await db.close();

            // --- Phase 2: Reopen and migrate to version 2 ---
            db = await getRootDatabase(caps);
            // Migrate: keep A, invalidate B. C is left undecided and will
            // become propagated invalidate via finalize().
            const migrated = await runMigration(caps, db, nodeDefs, async (storage) => {
                for await (const nk of storage.listMaterializedNodes()) {
                    const key = await storage.resolveNodeKey(nk);
                    if (!key) continue; // skip unresolvable
                    if (String(key.head) === "A") {
                        await storage.keep(nk);
                    } else if (String(key.head) === "B") {
                        await storage.invalidate(nk);
                    }
                    // C is deliberately left undecided
                }
            });

            // --- Phase 3: Verify post-migration state via active replica ---
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

            // Verify version and graph_scheme in the active replica
            expect(await storage.global.get("version")).toBeDefined();
            expect(await storage.global.get(GRAPH_SCHEME_KEY)).toBeDefined();

            // --- Phase 4: Open graph on the migrated replica and pull C ---
            // Track only post-migration calls. B already has a value and
            // must return makeUnchanged so its outgoing proof is preserved.
            aCalls = 0; bCalls = 0; cCalls = 0;
            const g2 = await createIncrementalGraph(caps, db, nodeDefs);
            const result = await g2.pull("C");
            // A is up-to-date — must not compute
            expect(aCalls).toBe(0);
            // B is a direct root (missing incoming proof) — must recompute
            expect(bCalls).toBe(1);
            // C is a propagated descendant with preserved valid[B].has(C) — cache-revalidates
            expect(cCalls).toBe(0);
            expect(result).toEqual({ v: 3 });

            // --- Phase 5: Final state assertions ---
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
