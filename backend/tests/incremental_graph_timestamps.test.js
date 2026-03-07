/**
 * Tests for the IncrementalGraph timestamp API.
 * Covers getCreationTime() and getModificationTime() methods.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const {
    makeIncrementalGraph,
    makeUnchanged,
    isMissingTimestamp,
    isInvalidNode,
} = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");
const { isDateTime } = require("../src/datetime");

/**
 * @typedef {import('../src/generators/incremental_graph/database/types').DatabaseCapabilities} DatabaseCapabilities
 */

/**
 * Creates test capabilities with a temporary data directory.
 * @returns {DatabaseCapabilities & { tmpDir: string }}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "incremental-graph-timestamps-test-")
    );

    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return { ...capabilities, tmpDir };
}

describe("generators/incremental_graph timestamps", () => {
    describe("getCreationTime()", () => {
        test("returns a DateTime after node is first computed", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => ({ type: "meta_events", meta_events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            await graph.invalidate("src");
            await graph.pull("src");

            const creationTime = await graph.getCreationTime("src");
            expect(isDateTime(creationTime)).toBe(true);

            await db.close();
        });

        test("returns a recent DateTime (within last 5 seconds)", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const before = Date.now();

            const graphDef = [
                {
                    output: "node1",
                    inputs: [],
                    computor: async () => ({ type: "meta_events", meta_events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);
            await graph.invalidate("node1");
            await graph.pull("node1");

            const after = Date.now();

            const creationTime = await graph.getCreationTime("node1");
            const creationMs = new Date(creationTime.toISOString()).getTime();

            expect(creationMs).toBeGreaterThanOrEqual(before);
            expect(creationMs).toBeLessThanOrEqual(after + 100);

            await db.close();
        });

        test("throws MissingTimestampError when node has never been computed", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => ({ type: "meta_events", meta_events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            // Node exists in schema but was never pulled
            let error = null;
            try {
                await graph.getCreationTime("src");
            } catch (err) {
                error = err;
            }
            expect(error).not.toBeNull();
            expect(isMissingTimestamp(error)).toBe(true);

            await db.close();
        });

        test("throws InvalidNodeError when node is not in schema", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graph = makeIncrementalGraph(db, []);

            let error = null;
            try {
                await graph.getCreationTime("nonexistent");
            } catch (err) {
                error = err;
            }
            expect(error).not.toBeNull();
            expect(isInvalidNode(error)).toBe(true);

            await db.close();
        });

        test("creation time does not change after re-computation", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            let callCount = 0;
            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => {
                        callCount++;
                        return { type: "meta_events", meta_events: [{ count: callCount }] };
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            // First computation
            await graph.invalidate("src");
            await graph.pull("src");
            const firstCreationTime = await graph.getCreationTime("src");

            // Small delay to ensure timestamps would differ
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Second computation (invalidate and pull again)
            await graph.invalidate("src");
            await graph.pull("src");
            const secondCreationTime = await graph.getCreationTime("src");

            // Creation time must not change
            expect(firstCreationTime.toISOString()).toBe(secondCreationTime.toISOString());

            await db.close();
        });

        test("works with parameterized nodes (bindings)", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "item(x)",
                    inputs: [],
                    computor: async (_inputs, _old, bindings) => ({
                        type: "meta_events",
                        meta_events: [{ id: bindings[0] }],
                    }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            await graph.invalidate("item", ["a"]);
            await graph.pull("item", ["a"]);

            await graph.invalidate("item", ["b"]);
            await graph.pull("item", ["b"]);

            const timeA = await graph.getCreationTime("item", ["a"]);
            const timeB = await graph.getCreationTime("item", ["b"]);

            expect(isDateTime(timeA)).toBe(true);
            expect(isDateTime(timeB)).toBe(true);

            await db.close();
        });

        test("throws MissingTimestampError for bindings that were never computed", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "item(x)",
                    inputs: [],
                    computor: async () => ({ type: "meta_events", meta_events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            await graph.invalidate("item", ["existing"]);
            await graph.pull("item", ["existing"]);

            // "missing" was never computed
            let error = null;
            try {
                await graph.getCreationTime("item", ["missing"]);
            } catch (err) {
                error = err;
            }
            expect(error).not.toBeNull();
            expect(isMissingTimestamp(error)).toBe(true);

            await db.close();
        });
    });

    describe("getModificationTime()", () => {
        test("returns a DateTime after node is first computed", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => ({ type: "meta_events", meta_events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            await graph.invalidate("src");
            await graph.pull("src");

            const modificationTime = await graph.getModificationTime("src");
            expect(isDateTime(modificationTime)).toBe(true);

            await db.close();
        });

        test("equals creation time after first computation", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => ({ type: "meta_events", meta_events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            await graph.invalidate("src");
            await graph.pull("src");

            const creationTime = await graph.getCreationTime("src");
            const modificationTime = await graph.getModificationTime("src");

            expect(creationTime.toISOString()).toBe(modificationTime.toISOString());

            await db.close();
        });

        test("throws MissingTimestampError when node has never been computed", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => ({ type: "meta_events", meta_events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            let error = null;
            try {
                await graph.getModificationTime("src");
            } catch (err) {
                error = err;
            }
            expect(error).not.toBeNull();
            expect(isMissingTimestamp(error)).toBe(true);

            await db.close();
        });

        test("throws InvalidNodeError when node is not in schema", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graph = makeIncrementalGraph(db, []);

            let error = null;
            try {
                await graph.getModificationTime("nonexistent");
            } catch (err) {
                error = err;
            }
            expect(error).not.toBeNull();
            expect(isInvalidNode(error)).toBe(true);

            await db.close();
        });

        test("modification time updates on re-computation with new value", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            let counter = 0;
            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => {
                        counter++;
                        return { type: "meta_events", meta_events: [{ seq: counter }] };
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            // First computation
            await graph.invalidate("src");
            await graph.pull("src");
            const firstModTime = await graph.getModificationTime("src");

            // Small delay to ensure time passes
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Second computation producing a different value
            await graph.invalidate("src");
            await graph.pull("src");
            const secondModTime = await graph.getModificationTime("src");

            const firstMs = new Date(firstModTime.toISOString()).getTime();
            const secondMs = new Date(secondModTime.toISOString()).getTime();

            expect(secondMs).toBeGreaterThanOrEqual(firstMs);

            await db.close();
        });

        test("modification time does not change when Unchanged is returned", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            let srcCell = { value: 1 };
            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => ({ type: "meta_events", meta_events: [{ v: srcCell.value }] }),
                    isDeterministic: false,
                    hasSideEffects: false,
                },
                {
                    output: "derived",
                    inputs: ["src"],
                    computor: async (inputs, oldValue) => {
                        if (oldValue !== undefined) {
                            return makeUnchanged();
                        }
                        return { type: "meta_events", meta_events: [] };
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            // First computation of derived
            await graph.invalidate("src");
            await graph.pull("derived");
            const firstModTime = await graph.getModificationTime("derived");

            // Small delay
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Second computation of derived - will return Unchanged
            srcCell.value = 2;
            await graph.invalidate("src");
            await graph.pull("derived");
            const secondModTime = await graph.getModificationTime("derived");

            // Modification time should not change since Unchanged was returned
            expect(firstModTime.toISOString()).toBe(secondModTime.toISOString());

            await db.close();
        });

        test("creation time preserved, modification time updated on value change", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            let counter = 0;
            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => {
                        counter++;
                        return { type: "meta_events", meta_events: [{ seq: counter }] };
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            // First computation
            await graph.invalidate("src");
            await graph.pull("src");
            const firstCreationTime = await graph.getCreationTime("src");
            const firstModTime = await graph.getModificationTime("src");

            // Wait a bit to ensure time difference is measurable
            await new Promise((resolve) => setTimeout(resolve, 10));

            // Second computation with different value
            await graph.invalidate("src");
            await graph.pull("src");
            const secondCreationTime = await graph.getCreationTime("src");
            const secondModTime = await graph.getModificationTime("src");

            // Creation time must stay the same
            expect(firstCreationTime.toISOString()).toBe(secondCreationTime.toISOString());

            // Modification time should be >= first mod time
            const firstModMs = new Date(firstModTime.toISOString()).getTime();
            const secondModMs = new Date(secondModTime.toISOString()).getTime();
            expect(secondModMs).toBeGreaterThanOrEqual(firstModMs);

            await db.close();
        });

        test("different nodes have independent timestamps", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "node1",
                    inputs: [],
                    computor: async () => ({ type: "meta_events", meta_events: [{ id: 1 }] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "node2",
                    inputs: [],
                    computor: async () => ({ type: "meta_events", meta_events: [{ id: 2 }] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            await graph.invalidate("node1");
            await graph.pull("node1");

            await new Promise((resolve) => setTimeout(resolve, 5));

            await graph.invalidate("node2");
            await graph.pull("node2");

            const time1 = await graph.getCreationTime("node1");
            const time2 = await graph.getCreationTime("node2");

            // Both should be valid DateTimes
            expect(isDateTime(time1)).toBe(true);
            expect(isDateTime(time2)).toBe(true);

            await db.close();
        });

        test("works with derived node that has inputs", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => ({ type: "meta_events", meta_events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
                {
                    output: "derived",
                    inputs: ["source"],
                    computor: async (inputs) => inputs[0],
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            await graph.invalidate("source");
            await graph.pull("derived");

            const sourceCreation = await graph.getCreationTime("source");
            const derivedCreation = await graph.getCreationTime("derived");

            expect(isDateTime(sourceCreation)).toBe(true);
            expect(isDateTime(derivedCreation)).toBe(true);

            await db.close();
        });
    });

    describe("isMissingTimestamp error guard", () => {
        test("correctly identifies MissingTimestampError", async () => {
            const capabilities = getTestCapabilities();
            const db = await getRootDatabase(capabilities);

            const graphDef = [
                {
                    output: "src",
                    inputs: [],
                    computor: async () => ({ type: "meta_events", meta_events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ];

            const graph = makeIncrementalGraph(db, graphDef);

            let caughtError;
            try {
                await graph.getCreationTime("src");
            } catch (err) {
                caughtError = err;
            }

            expect(caughtError).toBeDefined();
            expect(isMissingTimestamp(caughtError)).toBe(true);
            expect(isMissingTimestamp(new Error("generic"))).toBe(false);
            expect(isMissingTimestamp(null)).toBe(false);

            await db.close();
        });
    });
});
