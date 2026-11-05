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
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");
const { numberComputedValue, textComputedValue } = require("./computed_value_fixture");

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
        const graph = await createIncrementalGraph(capabilities, db, [
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
        const graph = await createIncrementalGraph(capabilities, db1, [
            {
                output: "source",
                inputs: [],
                computor: async () => numberComputedValue(42),
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

        // Construct graph first (writes initialization metadata via batch).
        const graph = await createIncrementalGraph(capabilities, db, [
            {
                output: "node_paused",
                inputs: [],
                computor: async () => numberComputedValue(10),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        // Now mock schemaStorage.batch to intercept the pull's flush.
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

        const graph = await createIncrementalGraph(capabilities, db, [
            {
                output: "source",
                inputs: [],
                computor: async () => numberComputedValue(1),
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
            { type: "calories", value: 1 },
            { type: "calories", value: 1 },
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

        const graph = await createIncrementalGraph(capabilities, db, [
            {
                output: "z",
                inputs: [],
                computor: async () => numberComputedValue(0),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "x",
                inputs: ["z"],
                computor: async ([zVal]) => numberComputedValue(zVal.value + 1),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "y",
                inputs: ["z"],
                computor: async ([zVal]) => numberComputedValue(zVal.value + 2),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        // Both pulls succeed even though Z is unseen — no commit conflict.
        const [xVal, yVal] = await Promise.all([
            graph.pull("x"),
            graph.pull("y"),
        ]);

        expect(xVal.value).toBe(1);
        expect(yVal.value).toBe(2);

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

        // Construct graph first (this writes initialization metadata via batch).
        const graph = await createIncrementalGraph(capabilities, db, [
            {
                output: "flush_fail_node",
                inputs: [],
                computor: async () => textComputedValue("value"),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        // Now mock schemaStorage.batch to fail so the pull flush is rejected.
        const schemaStorage = db.getSchemaStorage();
        const originalBatch = schemaStorage.batch.bind(schemaStorage);
        schemaStorage.batch = async () => {
            throw new Error("batch-fails-intentionally");
        };

        try {
            await expect(graph.pull("flush_fail_node")).rejects.toThrow(
                "batch-fails-intentionally"
            );
            expect(await graph.getFreshness("flush_fail_node")).toBeUndefined();

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
        const graph = await createIncrementalGraph(capabilities, db1, [
            {
                output: "stable",
                inputs: [],
                computor: async () => numberComputedValue(99),
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
        const graph = await createIncrementalGraph(capabilities, db, [
            {
                output: "a",
                inputs: [],
                computor: async () => numberComputedValue(1),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "b",
                inputs: [],
                computor: async () => numberComputedValue(2),
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
        const graph1 = await createIncrementalGraph(capabilities, db1, [
            {
                output: "node1",
                inputs: [],
                computor: async () => numberComputedValue(1),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "node2",
                inputs: [],
                computor: async () => numberComputedValue(2),
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
// A failed pull publishes nothing
// ---------------------------------------------------------------------------

describe("A failed pull publishes nothing", () => {
    test("when outer computation fails, no dependency state is durable", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        let sourceComputations = 0;
        const graph = await createIncrementalGraph(capabilities, db, [
            {
                output: "source",
                inputs: [],
                computor: async () => {
                    sourceComputations++;
                    return textComputedValue("good");
                },
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

        // source's pull ran as a dependency of derived's and computed once, but
        // the computor runs before the serialized finalization boundary: the whole
        // transition was abandoned, so source is materialized nowhere, durably
        // or otherwise.
        expect(sourceComputations).toBe(1);
        expect(await graph.getFreshness("source")).toBeUndefined();
        expect(await graph.getFreshness("derived")).toBeUndefined();

        // The next pull recomputes source, which is what must happen if the failed
        // pull left no value behind for it.
        await expect(graph.pull("source")).resolves.toEqual(textComputedValue("good"));
        expect(sourceComputations).toBe(2);

        await db.close();
    });
});

// ---------------------------------------------------------------------------
// Property 11 — Nested pulls submit independent batches
// ---------------------------------------------------------------------------

describe("Property 11 — Nested pulls publish with the pull which pulled them", () => {
    test("dependency and parent are both materialized after successful pull", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        let innerComputations = 0;

        const graph = await createIncrementalGraph(capabilities, db, [
            {
                output: "inner",
                inputs: [],
                computor: async () => {
                    innerComputations++;
                    return textComputedValue("inner-data");
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "outer",
                inputs: ["inner"],
                computor: async ([innerVal]) => textComputedValue(`outer(${innerVal.description})`),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        // Pull outer (which triggers inner as dependency).
        const result = await graph.pull("outer");
        expect(result.description).toBe("outer(inner-data)");
        expect(innerComputations).toBe(1);

        // Both inner and outer must be up-to-date after a single top-level pull.
        expect(await graph.getFreshness("inner")).toBe("up-to-date");
        expect(await graph.getFreshness("outer")).toBe("up-to-date");

        // Pulling outer again does not recompute inner: both are already
        // up-to-date, so the whole operation is a no-op and publishes nothing.
        await graph.pull("outer");
        expect(innerComputations).toBe(1);

        await db.close();
    });

    test("dependency and parent writes are flushed in one batch", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const schemaStorage = db.getSchemaStorage();
        // Each schemaStorage.<name> access returns a fresh typed wrapper, so the
        // operations name the level below it.
        const valuesLevel = schemaStorage.values.sublevel;
        const globalLevel = schemaStorage.global.sublevel;
        const journalLevel = schemaStorage.journal.sublevel;
        const originalBatch = schemaStorage.batch.bind(schemaStorage);
        /** @type {Array<Array<*>>} */
        const capturedBatches = [];
        schemaStorage.batch = async (operations) => {
            capturedBatches.push(operations);
            await originalBatch(operations);
        };

        try {
            const graph = await createIncrementalGraph(capabilities, db, [
                {
                    output: "inner_atomic",
                    inputs: [],
                    computor: async () => textComputedValue("inner-data"),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "outer_atomic",
                    inputs: ["inner_atomic"],
                    computor: async ([innerVal]) =>
                        textComputedValue(`outer(${innerVal.description})`),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);

            // Only the batches the pull itself issues are of interest; creating
            // the graph on a fresh database writes the graph scheme.
            capturedBatches.length = 0;

            await graph.pull("outer_atomic");

            // A nested dependency pull joins the operation which pulled it, so
            // the whole transition is one durable write. Anything else would let
            // the dependency be durable without the parent which needs it.
            expect(capturedBatches).toHaveLength(1);
            const flush = capturedBatches[0];

            // That one write carries both materialized values and one identifier table.
            expect(flush).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    type: "put",
                    sublevel: valuesLevel,
                    value: textComputedValue("inner-data"),
                }),
                expect.objectContaining({
                    type: "put",
                    sublevel: valuesLevel,
                    value: textComputedValue("outer(inner-data)"),
                }),
                expect.objectContaining({
                    type: "put",
                    sublevel: globalLevel,
                    key: IDENTIFIERS_KEY,
                }),
            ]));

            // It also carries the Journal records describing those materializations,
            // so the graph side and the journal side become durable together.
            expect(
                flush.filter((op) => op.sublevel === journalLevel)
            ).not.toHaveLength(0);
        } finally {
            schemaStorage.batch = originalBatch;
            await db.close();
        }
    });

    test("when outer pull fails, no dependency state is durable", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        let innerComputations = 0;

        const graph = await createIncrementalGraph(capabilities, db, [
            {
                output: "dep",
                inputs: [],
                computor: async () => {
                    innerComputations++;
                    return textComputedValue("dep-data");
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

        // dep's pull ran as a dependency of consumer's and computed once, but the
        // computor runs before the serialized finalization boundary: the whole
        // transition was abandoned, so dep is materialized nowhere.
        expect(await graph.getFreshness("dep")).toBeUndefined();
        expect(await graph.getFreshness("consumer")).toBeUndefined();

        // The next pull recomputes dep, which is what must happen if the failed
        // pull left no value behind for it.
        await expect(graph.pull("dep")).resolves.toEqual(textComputedValue("dep-data"));
        expect(innerComputations).toBe(2);

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
        const graph = await createIncrementalGraph(capabilities, db, [
            {
                output: "stable",
                inputs: [],
                computor: async () => textComputedValue("same"),
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
// Supplemental scenario — Read-only lookups do not interfere with allocations
// ---------------------------------------------------------------------------

describe("Supplemental scenario — Read-only lookups do not interfere with allocations", () => {
    test("getFreshness of existing nodes does not interfere with pulling new nodes", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const graph = await createIncrementalGraph(capabilities, db, [
            {
                output: "existing",
                inputs: [],
                computor: async () => textComputedValue("exists"),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "new_node",
                inputs: [],
                computor: async () => textComputedValue("new"),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        // Pull "existing" to allocate its identifier.
        await graph.pull("existing");

        // A read-only getFreshness on "existing" does not interfere.
        expect(await graph.getFreshness("existing")).toBe("up-to-date");
        // "new_node" is not yet pulled.
        expect(await graph.getFreshness("new_node")).toBeUndefined();

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

        const graph = await createIncrementalGraph(capabilities, db, [
            {
                output: "n1",
                inputs: [],
                computor: async () => {
                    started.push("n1");
                    await released.promise;
                    return numberComputedValue(1);
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
                    return numberComputedValue(2);
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
// Dependency lock ordering — static dependencies only
// ---------------------------------------------------------------------------

describe("Dependency lock ordering", () => {
    test("concurrent pulls with shared fresh dependencies in opposite input orders complete", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        const graph = await createIncrementalGraph(capabilities, db, [
            {
                output: "a",
                inputs: [],
                computor: async () => numberComputedValue(1),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "b",
                inputs: [],
                computor: async () => numberComputedValue(2),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "left",
                inputs: ["a", "b"],
                computor: async ([a, b]) => numberComputedValue(a.value + b.value),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "right",
                inputs: ["b", "a"],
                computor: async ([b, a]) => numberComputedValue(b.value - a.value),
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
            { type: "calories", value: 3 },
            { type: "calories", value: 1 },
        ]);

        await db.close();
    });

    test("concurrent opposite-order pulls complete when shared inputs were allocated earlier", async () => {
        const capabilities = getTestCapabilities();
        const db = await getRootDatabase(capabilities);

        const graph = await createIncrementalGraph(capabilities, db, [
            {
                output: "a",
                inputs: [],
                computor: async () => numberComputedValue(1),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "b",
                inputs: [],
                computor: async () => numberComputedValue(2),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "left",
                inputs: ["a", "b"],
                computor: async ([a, b]) => numberComputedValue(a.value + b.value),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "right",
                inputs: ["b", "a"],
                computor: async ([b, a]) => numberComputedValue(b.value - a.value),
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
            { type: "calories", value: 3 },
            { type: "calories", value: 1 },
        ]);

        await db.close();
    });
});

