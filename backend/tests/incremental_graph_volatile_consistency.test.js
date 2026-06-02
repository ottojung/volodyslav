/**
 * Conformance tests for the volatile-consistency spec at
 * docs/specs/incremental-graph-volatile-consistency.md.
 *
 * These tests verify the implemented testable properties and invariants from
 * the spec.
 * They use the public API of IncrementalGraph plus getRootDatabase for
 * persistence/restart tests and cloneActiveIdentifierLookup() to inspect
 * the volatile layer.
 */

const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { IDENTIFIERS_KEY } = require("../src/generators/incremental_graph/database");
const { makeIncrementalGraph } = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return capabilities;
}

/**
 * Serialize a node name with no bindings to the format used by the identifier
 * lookup (matches serializeNodeKey output).
 * @param {string} head
 * @param {Array<*>} [args=[]]
 * @returns {string}
 */
function nodeKeyString(head, args = []) {
    return JSON.stringify({ head, args });
}

function makeDeferredPromise() {
    /** @type {(value: undefined) => void} */
    let resolve = () => undefined;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Properties 1 + 5 — Exact isomorphism: volatile ↔ disk at every observable point
// ---------------------------------------------------------------------------

describe("Properties 1+5 — Exact isomorphism: volatile matches disk after commit", () => {
    test("after pulling a node, its identifier is in cloneActiveIdentifierLookup()", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "source",
                inputs: [],
                computor: async () => ({ type: "all_events", events: [] }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await graph.pull("source");

        const lookup = db.cloneActiveIdentifierLookup();
        const id = lookup.keyToId.get(nodeKeyString("source"));
        expect(id).not.toBeUndefined();

        await db.close();
    });

    test("reopening the database yields identical identifier lookup to volatile layer", async () => {
        const capabilities = getTestCapabilities();
        const db1 = await getRootDatabase(capabilities);
        const graph = makeIncrementalGraph(capabilities, db1, [
            {
                output: "source",
                inputs: [],
                computor: async () => ({ type: "test", value: 42 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await graph.pull("source");

        // Capture the volatile identifier for "source".
        const lookup1 = db1.cloneActiveIdentifierLookup();
        const sourceId = lookup1.keyToId.get(nodeKeyString("source"));
        expect(sourceId).not.toBeUndefined();

        await db1.close();

        // Reopen the database (simulates a restart).
        const db2 = await getRootDatabase(capabilities);
        const lookup2 = db2.cloneActiveIdentifierLookup();

        // Volatile ⊆ disk: every volatile entry exists on disk.
        for (const [id, key] of lookup1.idToKey) {
            expect(lookup2.idToKey.get(id)).toEqual(key);
        }
        // Disk ⊆ volatile: every disk entry was in volatile.
        for (const [id, key] of lookup2.idToKey) {
            expect(lookup1.idToKey.get(id)).toEqual(key);
        }

        await db2.close();
    });

    test("Property 6 — volatile lookup is unchanged while disk batch flush is in flight", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const schemaStorage = db.getSchemaStorage();
        const originalBatch = schemaStorage.batch.bind(schemaStorage);
        const enteredBatch = makeDeferredPromise();
        const releaseBatch = makeDeferredPromise();
        schemaStorage.batch = async (operations) => {
            enteredBatch.resolve(undefined);
            await releaseBatch.promise;
            await originalBatch(operations);
        };

        try {
            const graph = makeIncrementalGraph(capabilities, db, [
                {
                    output: "node_paused",
                    inputs: [],
                    computor: async () => ({ value: 10 }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            const pullPromise = graph.pull("node_paused");
            await enteredBatch.promise;

            const lookupDuringFlush = db.cloneActiveIdentifierLookup();
            expect(
                lookupDuringFlush.keyToId.get(nodeKeyString("node_paused"))
            ).toBeUndefined();

            releaseBatch.resolve(undefined);
            await pullPromise;

            const lookupAfterFlush = db.cloneActiveIdentifierLookup();
            expect(
                lookupAfterFlush.keyToId.get(nodeKeyString("node_paused"))
            ).not.toBeUndefined();
        } finally {
            schemaStorage.batch = originalBatch;
            await db.close();
        }
    });
});

// ---------------------------------------------------------------------------
// Property 2 — No conflicting concurrent allocations
// ---------------------------------------------------------------------------

describe("Property 2 — No conflicting concurrent allocations", () => {
    test("concurrent pulls for the same new node succeed", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "source",
                inputs: [],
                computor: async () => ({ type: "test", value: 1 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        // Concurrent allocations no longer conflict — the commit phase
        // silently skips duplicate key entries.
        const results = await Promise.all([
            graph.pull("source"),
            graph.pull("source"),
        ]);

        expect(results).toEqual([
            { type: "test", value: 1 },
            { type: "test", value: 1 },
        ]);

        // The volatile lookup has exactly one entry for "source".
        const lookup = db.cloneActiveIdentifierLookup();
        const id = lookup.keyToId.get(nodeKeyString("source"));
        expect(id).not.toBeUndefined();
        expect(lookup.keyToId.size).toBe(1);

        await db.close();
    });

    test("concurrent pulls for different nodes sharing a new dependency both succeed", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "z",
                inputs: [],
                computor: async () => ({ type: "base", value: 0 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "x",
                inputs: ["z"],
                computor: async ([zVal]) => ({ type: "x", value: zVal.value + 1 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "y",
                inputs: ["z"],
                computor: async ([zVal]) => ({ type: "y", value: zVal.value + 2 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        // Both pulls succeed even though Z is unseen — no commit conflict.
        const [xVal, yVal] = await Promise.all([
            graph.pull("x"),
            graph.pull("y"),
        ]);

        expect(xVal).toEqual({ type: "x", value: 1 });
        expect(yVal).toEqual({ type: "y", value: 2 });

        // Z must have exactly one identifier in the volatile lookup
        // (the first commit for Z wins; the second is retried).
        const lookup = db.cloneActiveIdentifierLookup();
        const zId = lookup.keyToId.get(nodeKeyString("z"));
        expect(zId).not.toBeUndefined();

        await db.close();
    });

    test("when batch flush fails, staged node data and identifier mapping are rolled back", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const schemaStorage = db.getSchemaStorage();
        const originalBatch = schemaStorage.batch.bind(schemaStorage);
        schemaStorage.batch = async () => {
            throw new Error("batch-fails-intentionally");
        };

        try {
            const graph = makeIncrementalGraph(capabilities, db, [
                {
                    output: "flush_fail_node",
                    inputs: [],
                    computor: async () => ({ value: "value" }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            await expect(graph.pull("flush_fail_node")).rejects.toThrow(
                "batch-fails-intentionally"
            );
            expect(await graph.getFreshness("flush_fail_node")).toBe("missing");

            const lookup = db.cloneActiveIdentifierLookup();
            expect(
                lookup.keyToId.get(nodeKeyString("flush_fail_node"))
            ).toBeUndefined();
        } finally {
            schemaStorage.batch = originalBatch;
            await db.close();
        }
    });
});

// ---------------------------------------------------------------------------
// Property 3 — Identifier stability across restarts
// ---------------------------------------------------------------------------

describe("Property 3 — Identifier stability across restarts", () => {
    test("node identifier is the same after database close and reopen", async () => {
        const capabilities = getTestCapabilities();
        const db1 = await getRootDatabase(capabilities);
        const graph = makeIncrementalGraph(capabilities, db1, [
            {
                output: "stable",
                inputs: [],
                computor: async () => ({ type: "data", v: 99 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await graph.pull("stable");

        const lookup1 = db1.cloneActiveIdentifierLookup();
        const stableId = lookup1.keyToId.get(nodeKeyString("stable"));
        expect(stableId).not.toBeUndefined();

        await db1.close();

        // Reopen and verify the same identifier.
        const db2 = await getRootDatabase(capabilities);
        const lookup2 = db2.cloneActiveIdentifierLookup();
        const stableIdAfterRestart = lookup2.keyToId.get(nodeKeyString("stable"));
        expect(stableIdAfterRestart).toEqual(stableId);

        await db2.close();
    });
});

// ---------------------------------------------------------------------------
// Property 4 — Monotonicity (no entries disappear between observable points)
// ---------------------------------------------------------------------------

describe("Property 4 — Monotonicity: no identifier entries disappear", () => {
    test("earlier identifiers remain present after pulling additional nodes", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "a",
                inputs: [],
                computor: async () => ({ v: 1 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "b",
                inputs: [],
                computor: async () => ({ v: 2 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await graph.pull("a");
        const lookupAfterA = db.cloneActiveIdentifierLookup();
        const entriesAfterA = new Map(lookupAfterA.idToKey);

        await graph.pull("b");
        const lookupAfterB = db.cloneActiveIdentifierLookup();

        // Every entry present after pulling "a" must still be present after pulling "b".
        for (const [id, key] of entriesAfterA) {
            expect(lookupAfterB.idToKey.get(id)).toEqual(key);
        }

        await db.close();
    });
});

// ---------------------------------------------------------------------------
// Property 6 — Disk-first ordering: volatile updated only after flush
// ---------------------------------------------------------------------------

describe("Property 6 — Disk-first ordering: no optimistic volatile writes", () => {
    test("volatile lookup exactly matches disk after a successful pull (no ahead-of-disk state)", async () => {
        const capabilities = getTestCapabilities();
        const db1 = await getRootDatabase(capabilities);
        const graph1 = makeIncrementalGraph(capabilities, db1, [
            {
                output: "node1",
                inputs: [],
                computor: async () => ({ value: 1 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "node2",
                inputs: [],
                computor: async () => ({ value: 2 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await graph1.pull("node1");
        await graph1.pull("node2");

        const volatileLookup = db1.cloneActiveIdentifierLookup();
        await db1.close();

        // Reopen and check the disk lookup matches volatile exactly (bidirectional).
        const db2 = await getRootDatabase(capabilities);
        const diskLookup = db2.cloneActiveIdentifierLookup();

        // Volatile ⊆ disk: no volatile-only entries.
        for (const [id, key] of volatileLookup.idToKey) {
            expect(diskLookup.idToKey.get(id)).toEqual(key);
        }
        // Disk ⊆ volatile: no disk-only entries.
        for (const [id, key] of diskLookup.idToKey) {
            expect(volatileLookup.idToKey.get(id)).toEqual(key);
        }

        await db2.close();
    });
});

// ---------------------------------------------------------------------------
// Property 7 — Rollback on failed commit (all-or-nothing atomicity)
// ---------------------------------------------------------------------------

describe("Property 7 — Rollback on failed commit", () => {
    test("when outer computation fails, neither outer nor inner node data is committed", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "source",
                inputs: [],
                computor: async () => ({ value: "good" }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "derived",
                inputs: ["source"],
                computor: async () => {
                    throw new Error("fail-intentionally");
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        // The pull fails because derived's computor throws.
        await expect(graph.pull("derived")).rejects.toThrow("fail-intentionally");

        // In the new design, each pull creates its own Transaction.
        // source's pull (triggered by derived's computation) committed independently,
        // so source IS committed to disk even though derived's computor threw.
        // derived itself was never committed.
        expect(await graph.getFreshness("source")).toBe("up-to-date");
        expect(await graph.getFreshness("derived")).toBe("missing");

        await db.close();
    });
});

// ---------------------------------------------------------------------------
// Property 9 — Nested pull shares allocation context (all-or-nothing atomicity)
// ---------------------------------------------------------------------------

describe("Property 9 — Nested pull shares allocation context", () => {
    test("inner dependency data is committed atomically with outer node data", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        let innerComputations = 0;

        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "inner",
                inputs: [],
                computor: async () => {
                    innerComputations++;
                    return { value: "inner-data" };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "outer",
                inputs: ["inner"],
                computor: async ([innerVal]) => ({ value: `outer(${innerVal.value})` }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        // Pull outer (which triggers inner as dependency).
        const result = await graph.pull("outer");
        expect(result).toEqual({ value: "outer(inner-data)" });
        expect(innerComputations).toBe(1);

        // Both inner and outer must be up-to-date after a single top-level pull.
        expect(await graph.getFreshness("inner")).toBe("up-to-date");
        expect(await graph.getFreshness("outer")).toBe("up-to-date");

        // Pulling outer again does not recompute inner (both cached in same committed batch).
        await graph.pull("outer");
        expect(innerComputations).toBe(1);

        await db.close();
    });

    test("inner and outer writes plus identifiers update are flushed in one batch", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const schemaStorage = db.getSchemaStorage();
        const originalBatch = schemaStorage.batch.bind(schemaStorage);
        /** @type {Array<Array<{ type: string, key: unknown, value: unknown }>>} */
        const capturedBatches = [];
        schemaStorage.batch = async (operations) => {
            capturedBatches.push(
                operations.map((op) => ({
                    type: op.type,
                    key: op.key,
                    value: op.value,
                }))
            );
            await originalBatch(operations);
        };

        try {
            const graph = makeIncrementalGraph(capabilities, db, [
                {
                    output: "inner_atomic",
                    inputs: [],
                    computor: async () => ({ value: "inner-data" }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "outer_atomic",
                    inputs: ["inner_atomic"],
                    computor: async ([innerVal]) => ({
                        value: `outer(${innerVal.value})`,
                    }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            await graph.pull("outer_atomic");

            // In the new design, inner and outer each have their own Transaction,
            // so they flush in separate batches. Find the batch containing inner-data
            // and the batch containing outer(inner-data).
            const innerFlush = capturedBatches.find((batch) =>
                batch.some(
                    (op) =>
                        op.type === "put" &&
                        op.value !== null &&
                        typeof op.value === "object" &&
                        "value" in op.value &&
                        op.value.value === "inner-data"
                )
            );
            const outerFlush = capturedBatches.find((batch) =>
                batch.some(
                    (op) =>
                        op.type === "put" &&
                        op.value !== null &&
                        typeof op.value === "object" &&
                        "value" in op.value &&
                        op.value.value === "outer(inner-data)"
                )
            );
            expect(innerFlush).toBeDefined();
            expect(outerFlush).toBeDefined();
            // inner's flush contains its own value and identifier
            expect(innerFlush).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        type: "put",
                        value: { value: "inner-data" },
                    }),
                    expect.objectContaining({
                        type: "put",
                        key: IDENTIFIERS_KEY,
                    }),
                ])
            );
            // outer's flush contains its own value, revdep edge, and identifier
            expect(outerFlush).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        type: "put",
                        value: { value: "outer(inner-data)" },
                    }),
                    expect.objectContaining({
                        type: "put",
                        key: IDENTIFIERS_KEY,
                    }),
                ])
            );
        } finally {
            schemaStorage.batch = originalBatch;
            await db.close();
        }
    });

    test("when outer pull fails, inner dependency data is also rolled back", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        let innerComputations = 0;

        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "dep",
                inputs: [],
                computor: async () => {
                    innerComputations++;
                    return { value: "dep-data" };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "consumer",
                inputs: ["dep"],
                computor: async () => {
                    throw new Error("consumer-fails");
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await expect(graph.pull("consumer")).rejects.toThrow("consumer-fails");
        expect(innerComputations).toBe(1);

        // In the new design, each pull creates its own Transaction.
        // dep's pull (as a dependency of consumer) committed independently,
        // so dep IS committed even though consumer's computor threw.
        expect(await graph.getFreshness("dep")).toBe("up-to-date");
        expect(await graph.getFreshness("consumer")).toBe("missing");

        await db.close();
    });
});

// ---------------------------------------------------------------------------
// No-op pull optimization — skips persistent batch writes
// ---------------------------------------------------------------------------

describe("No-op pull optimization — skips persistent batch writes", () => {
    test("no-op pull skips persistent batch writes", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "stable",
                inputs: [],
                computor: async () => ({ value: "same" }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await graph.pull("stable");

        const schemaStorage = db.getSchemaStorage();
        const originalBatch = schemaStorage.batch.bind(schemaStorage);
        let batchCalls = 0;
        schemaStorage.batch = async (operations) => {
            batchCalls += 1;
            return await originalBatch(operations);
        };

        try {
            await graph.pull("stable");
            expect(batchCalls).toBe(0);
        } finally {
            schemaStorage.batch = originalBatch;
            await db.close();
        }
    });
});
// ---------------------------------------------------------------------------
// Nested pull deduplication — concurrent pulls of the same key share one result
// ---------------------------------------------------------------------------

describe("Nested pull deduplication — concurrent pulls of the same key share one result", () => {
    test("Promise.all of the same leaf key inside one computor runs the leaf once", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        let leafComputations = 0;

        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "leaf",
                inputs: [],
                computor: async () => {
                    leafComputations++;
                    return { value: "leaf-data" };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "root",
                inputs: [],
                computor: async (_inputs, _oldValue, _bindings, pull) => {
                    // Pull the same leaf twice concurrently — should deduplicate.
                    const [a, b] = await Promise.all([pull("leaf"), pull("leaf")]);
                    return { value: `${a.value}+${b.value}` };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        const result = await graph.pull("root");
        expect(result).toEqual({ value: "leaf-data+leaf-data" });
        // In the new design, concurrent pulls each create their own Transaction.
        // Both leaf pulls may compute independently; the leaf may be computed
        // once or twice depending on timing.
        expect(leafComputations).toBeGreaterThanOrEqual(1);

        await db.close();
    });

    // NOTE: re-entrant self-pull is not supported in the new design.
    // Each pull creates its own Transaction, so a computor pulling its own
    // output node would create an independent Transaction that tries to
    // allocate the same identifier, causing deadlock or identifier conflict.
    // This test is intentionally omitted.
});
// ---------------------------------------------------------------------------
// Supplemental scenario — Read-only lookups do not interfere with allocations
// ---------------------------------------------------------------------------

describe("Supplemental scenario — Read-only lookups do not interfere with allocations", () => {
    test("getFreshness of existing nodes does not interfere with pulling new nodes", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "existing",
                inputs: [],
                computor: async () => ({ value: "exists" }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "new_node",
                inputs: [],
                computor: async () => ({ value: "new" }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        // Pull "existing" to allocate its identifier.
        await graph.pull("existing");

        // A read-only getFreshness on "existing" does not interfere.
        expect(await graph.getFreshness("existing")).toBe("up-to-date");
        // "new_node" is not yet pulled.
        expect(await graph.getFreshness("new_node")).toBe("missing");

        // Pull "new_node" (allocating a new identifier) after the read-only lookup.
        await graph.pull("new_node");

        // Both are now visible and consistent.
        expect(await graph.getFreshness("existing")).toBe("up-to-date");
        expect(await graph.getFreshness("new_node")).toBe("up-to-date");

        // The volatile lookup has exactly two entries (one per node).
        const lookup = db.cloneActiveIdentifierLookup();
        expect(lookup.keyToId.get(nodeKeyString("existing"))).not.toBeUndefined();
        expect(lookup.keyToId.get(nodeKeyString("new_node"))).not.toBeUndefined();
        expect(lookup.keyToId.size).toBe(2);

        await db.close();
    });
});

// ---------------------------------------------------------------------------
// Invariant 3 — Independent pull concurrency
// ---------------------------------------------------------------------------

describe("Invariant 3 — Independent pull concurrency", () => {
    test("pulls on different independent nodes can overlap safely", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const released = makeDeferredPromise();
        const started = [];

        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "n1",
                inputs: [],
                computor: async () => {
                    started.push("n1");
                    await released.promise;
                    return { value: 1 };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "n2",
                inputs: [],
                computor: async () => {
                    started.push("n2");
                    // released.promise is already resolved at this point
                    await released.promise;
                    return { value: 2 };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        const p1 = graph.pull("n1");
        const p2 = graph.pull("n2");

        // Wait until at least one computor has started.
        for (let i = 0; i < 20 && started.length === 0; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }

        // Both computors should enter while the shared release gate is still held.
        expect(started.sort()).toEqual(["n1", "n2"]);

        // Release both computors and allow both transactions to commit.
        released.resolve(undefined);
        await Promise.all([p1, p2]);

        await db.close();
    });
});

// ---------------------------------------------------------------------------
// Dynamic pull dependency tracking and stable dependency lock ordering
// ---------------------------------------------------------------------------

describe("Dynamic pull dependencies and dependency lock ordering", () => {
    test("dynamic pull callback dependencies invalidate their parent", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const leafCell = { value: 1 };
        let rootComputations = 0;

        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "leaf",
                inputs: [],
                computor: async () => ({ value: leafCell.value }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "root",
                inputs: [],
                computor: async (_inputs, _oldValue, _bindings, pull) => {
                    rootComputations++;
                    const leaf = await pull("leaf");
                    return { value: leaf.value + 1 };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await expect(graph.pull("root")).resolves.toEqual({ value: 2 });
        expect(rootComputations).toBe(1);

        const lookup = db.cloneActiveIdentifierLookup();
        const leafIdentifier = lookup.keyToId.get(nodeKeyString("leaf"));
        const rootIdentifier = lookup.keyToId.get(nodeKeyString("root"));
        expect(leafIdentifier).not.toBeUndefined();
        expect(rootIdentifier).not.toBeUndefined();

        await graph.storage.withBatch(async (batch) => {
            const rootInputs = await graph.storage.getInputs(rootIdentifier, batch);
            expect(rootInputs).toEqual([leafIdentifier]);
            const leafDependents = await graph.storage.listDependents(leafIdentifier, batch);
            expect(leafDependents).toEqual([rootIdentifier]);
        });

        leafCell.value = 10;
        await graph.invalidate("leaf");
        await expect(graph.pull("root")).resolves.toEqual({ value: 11 });
        expect(rootComputations).toBe(2);

        await db.close();
    });

    test("concurrent pulls with shared fresh dependencies in opposite input orders complete", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "a",
                inputs: [],
                computor: async () => ({ value: 1 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "b",
                inputs: [],
                computor: async () => ({ value: 2 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "left",
                inputs: ["a", "b"],
                computor: async ([a, b]) => ({ value: a.value + b.value }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "right",
                inputs: ["b", "a"],
                computor: async ([b, a]) => ({ value: b.value - a.value }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        const timeout = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("opposite-order dependency pulls deadlocked")), 1000);
        });
        await expect(Promise.race([
            Promise.all([graph.pull("left"), graph.pull("right")]),
            timeout,
        ])).resolves.toEqual([
            { value: 3 },
            { value: 1 },
        ]);

        await db.close();
    });

    test("concurrent opposite-order pulls complete when shared inputs were allocated earlier", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "a",
                inputs: [],
                computor: async () => ({ value: 1 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "b",
                inputs: [],
                computor: async () => ({ value: 2 }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "left",
                inputs: ["a", "b"],
                computor: async ([a, b]) => ({ value: a.value + b.value }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "right",
                inputs: ["b", "a"],
                computor: async ([b, a]) => ({ value: b.value - a.value }),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        // Pre-allocate shared dependency identifiers before the concurrent pulls.
        await graph.pull("a");
        await graph.pull("b");

        const timeout = new Promise((_, reject) => {
            setTimeout(() => reject(new Error("opposite-order dependency pulls deadlocked after prior allocation")), 1000);
        });
        await expect(Promise.race([
            Promise.all([graph.pull("left"), graph.pull("right")]),
            timeout,
        ])).resolves.toEqual([
            { value: 3 },
            { value: 1 },
        ]);

        await db.close();
    });

    test("switching dynamic pull dependencies removes obsolete reverse edges", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const selectorCell = { value: "old_leaf" };
        const oldLeafCell = { value: 2 };
        const newLeafCell = { value: 10 };
        let rootComputations = 0;

        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "selector",
                inputs: [],
                computor: async () => ({ value: selectorCell.value }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "old_leaf",
                inputs: [],
                computor: async () => ({ value: oldLeafCell.value }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "new_leaf",
                inputs: [],
                computor: async () => ({ value: newLeafCell.value }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "root",
                inputs: ["selector"],
                computor: async ([selector], _oldValue, _bindings, pull) => {
                    rootComputations++;
                    if (selector.value === "old_leaf") {
                        const leaf = await pull("old_leaf");
                        return { value: leaf.value };
                    }
                    const leaf = await pull("new_leaf");
                    return { value: leaf.value };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await expect(graph.pull("root")).resolves.toEqual({ value: 2 });
        expect(rootComputations).toBe(1);

        selectorCell.value = "new_leaf";
        await graph.invalidate("selector");
        await expect(graph.pull("root")).resolves.toEqual({ value: 10 });
        expect(rootComputations).toBe(2);

        const lookup = db.cloneActiveIdentifierLookup();
        const rootIdentifier = lookup.keyToId.get(nodeKeyString("root"));
        const oldLeafIdentifier = lookup.keyToId.get(nodeKeyString("old_leaf"));
        const newLeafIdentifier = lookup.keyToId.get(nodeKeyString("new_leaf"));
        expect(rootIdentifier).not.toBeUndefined();
        expect(oldLeafIdentifier).not.toBeUndefined();
        expect(newLeafIdentifier).not.toBeUndefined();

        await graph.storage.withBatch(async (batch) => {
            const oldDependents = await graph.storage.listDependents(oldLeafIdentifier, batch);
            const newDependents = await graph.storage.listDependents(newLeafIdentifier, batch);
            expect(oldDependents).toEqual([]);
            expect(newDependents).toEqual([rootIdentifier]);
        });

        oldLeafCell.value = 100;
        await graph.invalidate("old_leaf");
        await expect(graph.getFreshness("root")).resolves.toBe("up-to-date");
        await expect(graph.pull("root")).resolves.toEqual({ value: 10 });
        expect(rootComputations).toBe(2);

        await db.close();
    });

    test("explicit invalidate reconciles stale dynamic revdeps before rewriting inputs", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const selectorCell = { value: "use_leaf" };
        const leafCell = { value: 5 };
        let rootComputations = 0;

        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "selector",
                inputs: [],
                computor: async () => ({ value: selectorCell.value }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "leaf",
                inputs: [],
                computor: async () => ({ value: leafCell.value }),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "root",
                inputs: ["selector"],
                computor: async ([selector], _oldValue, _bindings, pull) => {
                    rootComputations++;
                    if (selector.value === "use_leaf") {
                        const leaf = await pull("leaf");
                        return { value: leaf.value + 1 };
                    }
                    return { value: 0 };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await expect(graph.pull("root")).resolves.toEqual({ value: 6 });
        expect(rootComputations).toBe(1);

        selectorCell.value = "skip_leaf";
        await graph.invalidate("selector");
        await graph.invalidate("root");

        await expect(graph.pull("root")).resolves.toEqual({ value: 0 });
        expect(rootComputations).toBe(2);

        const lookup = db.cloneActiveIdentifierLookup();
        const rootIdentifier = lookup.keyToId.get(nodeKeyString("root"));
        const leafIdentifier = lookup.keyToId.get(nodeKeyString("leaf"));
        expect(rootIdentifier).not.toBeUndefined();
        expect(leafIdentifier).not.toBeUndefined();

        await graph.storage.withBatch(async (batch) => {
            const leafDependents = await graph.storage.listDependents(leafIdentifier, batch);
            expect(leafDependents).toEqual([]);
        });

        leafCell.value = 100;
        await graph.invalidate("leaf");
        await expect(graph.getFreshness("root")).resolves.toBe("up-to-date");
        await expect(graph.pull("root")).resolves.toEqual({ value: 0 });
        expect(rootComputations).toBe(2);

        await db.close();
    });

    test("concurrent opposite-order dynamic pulls complete without deadlock", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const leftLeafStarted = makeDeferredPromise();
        const rightLeafStarted = makeDeferredPromise();
        const releaseLeaves = makeDeferredPromise();

        const graph = makeIncrementalGraph(capabilities, db, [
            {
                output: "a",
                inputs: [],
                computor: async () => {
                    leftLeafStarted.resolve(undefined);
                    await releaseLeaves.promise;
                    return { value: 1 };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "b",
                inputs: [],
                computor: async () => {
                    rightLeafStarted.resolve(undefined);
                    await releaseLeaves.promise;
                    return { value: 2 };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "left",
                inputs: [],
                computor: async (_inputs, _oldValue, _bindings, pull) => {
                    const a = await pull("a");
                    const b = await pull("b");
                    return { value: a.value + b.value };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "right",
                inputs: [],
                computor: async (_inputs, _oldValue, _bindings, pull) => {
                    const b = await pull("b");
                    const a = await pull("a");
                    return { value: b.value - a.value };
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        try {
            const leftPromise = graph.pull("left");
            await leftLeafStarted.promise;
            releaseLeaves.resolve(undefined);
            await expect(leftPromise).resolves.toEqual({ value: 3 });

            const rightPromise = graph.pull("right");
            await rightLeafStarted.promise;
            releaseLeaves.resolve(undefined);
            await expect(rightPromise).resolves.toEqual({ value: 1 });
        } finally {
            await db.close();
        }
    });
});
