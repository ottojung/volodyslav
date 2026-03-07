/**
 * Tests for the graph inspection REST API routes.
 */

const request = require("supertest");
const express = require("express");
const { makeRouter } = require("../src/routes/graph");

/**
 * Builds a minimal mock CompiledNode for testing.
 * @param {string} head
 * @param {number} arity
 * @param {object} [overrides]
 * @returns {object}
 */
function makeMockCompiledNode(head, arity, overrides = {}) {
    const inputs = arity > 0 ? [`${head}_input`] : [];
    return {
        head,
        arity,
        canonicalOutput: arity === 0 ? head : `${head}(x)`,
        canonicalInputs: inputs,
        source: {
            isDeterministic: true,
            hasSideEffects: false,
        },
        ...overrides,
    };
}

const { makeMissingTimestampError } = require("../src/generators/incremental_graph");

/**
 * Creates a mock DateTime-like object with a toISOString() method.
 * @param {string} iso
 * @returns {object}
 */
function makeMockDateTime(iso) {
    return { toISOString: () => iso };
}

/**
 * Builds a minimal mock interface-backed graph accessor for testing.
 * @param {object} [opts]
 * @param {Map<string, object>} [opts.headIndex] - schema map
 * @param {Array<[string, Array<string>]>} [opts.materialized] - list of materialized nodes
 * @param {Map<string, string>} [opts.freshness] - freshness per serialized key
 * @param {Map<string, unknown>} [opts.values] - values per serialized key
 * @param {Map<string, {createdAt: string, modifiedAt: string}>} [opts.timestamps] - timestamps per serialized key
 * @returns {object}
 */
function makeMockInterface({
    headIndex = new Map(),
    materialized = [],
    freshness = new Map(),
    values = new Map(),
    timestamps = new Map(),
} = {}) {
    return {
        headIndex,
        debugGetSchemas: jest.fn().mockImplementation(() => Array.from(headIndex.values())),
        debugGetSchemaByHead: jest.fn().mockImplementation((head) => headIndex.get(head) ?? null),
        debugListMaterializedNodes: jest.fn().mockResolvedValue(materialized),
        debugGetFreshness: jest.fn().mockImplementation(async (head, args) => {
            const key = JSON.stringify({ head, args });
            return freshness.get(key) ?? "missing";
        }),
        debugGetValue: jest.fn().mockImplementation(async (head, args) => {
            const key = JSON.stringify({ head, args });
            return values.get(key);
        }),
        getCreationTime: jest.fn().mockImplementation(async (head, args) => {
            const key = JSON.stringify({ head, args });
            const record = timestamps.get(key);
            if (record === undefined) {
                throw makeMissingTimestampError(key);
            }
            return makeMockDateTime(record.createdAt);
        }),
        getModificationTime: jest.fn().mockImplementation(async (head, args) => {
            const key = JSON.stringify({ head, args });
            const record = timestamps.get(key);
            if (record === undefined) {
                throw makeMissingTimestampError(key);
            }
            return makeMockDateTime(record.modifiedAt);
        }),
    };
}

/**
 * Sets up a test app with optional mock graph.
 * @param {object|null} mockGraph - if null, graph is uninitialized (503 scenario)
 * @returns {object} Express app
 */
function makeTestApp(mockGraph) {
    const capabilities = {
        interface: {
            isInitialized: jest.fn(() => mockGraph !== null),
            debugGetSchemas: jest.fn(() => mockGraph === null ? [] : mockGraph.debugGetSchemas()),
            debugGetSchemaByHead: jest.fn((head) => mockGraph === null ? null : mockGraph.debugGetSchemaByHead(head)),
            debugListMaterializedNodes: jest.fn(async () => mockGraph === null ? [] : await mockGraph.debugListMaterializedNodes()),
            debugGetFreshness: jest.fn(async (head, args) => mockGraph === null ? "missing" : await mockGraph.debugGetFreshness(head, args)),
            debugGetValue: jest.fn(async (head, args) => mockGraph === null ? undefined : await mockGraph.debugGetValue(head, args)),
            getCreationTime: jest.fn(async (head, args) => {
                if (mockGraph === null) {
                    throw makeMissingTimestampError(JSON.stringify({ head, args }));
                }
                return await mockGraph.getCreationTime(head, args);
            }),
            getModificationTime: jest.fn(async (head, args) => {
                if (mockGraph === null) {
                    throw makeMissingTimestampError(JSON.stringify({ head, args }));
                }
                return await mockGraph.getModificationTime(head, args);
            }),
        },
    };

    const app = express();
    app.use(express.json());
    app.use("/api", makeRouter(capabilities));
    return app;
}

// ---------------------------------------------------------------------------
// GET /api/graph/schemas
// ---------------------------------------------------------------------------
describe("GET /api/graph/schemas", () => {
    it("returns 503 when graph is not initialized", async () => {
        const app = makeTestApp(null);
        const res = await request(app).get("/api/graph/schemas");
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: "Graph not yet initialized" });
    });

    it("returns empty array when no schemas are defined", async () => {
        const graph = makeMockInterface();
        const app = makeTestApp(graph);
        const res = await request(app).get("/api/graph/schemas");
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("returns all schema entries with correct fields", async () => {
        const headIndex = new Map([
            ["all_events", makeMockCompiledNode("all_events", 0, {
                source: { isDeterministic: false, hasSideEffects: false },
            })],
            ["event", makeMockCompiledNode("event", 1, {
                canonicalOutput: "event(x)",
                canonicalInputs: ["all_events"],
                source: { isDeterministic: true, hasSideEffects: false },
            })],
        ]);
        const graph = makeMockInterface({ headIndex });
        const app = makeTestApp(graph);

        const res = await request(app).get("/api/graph/schemas");
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);

        const allEvents = res.body.find((s) => s.head === "all_events");
        expect(allEvents).toEqual({
            head: "all_events",
            arity: 0,
            output: "all_events",
            inputs: [],
            isDeterministic: false,
            hasSideEffects: false,
        });

        const event = res.body.find((s) => s.head === "event");
        expect(event).toEqual({
            head: "event",
            arity: 1,
            output: "event(x)",
            inputs: ["all_events"],
            isDeterministic: true,
            hasSideEffects: false,
        });
    });
});

// ---------------------------------------------------------------------------
// GET /api/graph/schemas/:head
// ---------------------------------------------------------------------------
describe("GET /api/graph/schemas/:head", () => {
    it("returns 503 when graph is not initialized", async () => {
        const app = makeTestApp(null);
        const res = await request(app).get("/api/graph/schemas/all_events");
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: "Graph not yet initialized" });
    });

    it("returns 404 for unknown head", async () => {
        const graph = makeMockInterface();
        const app = makeTestApp(graph);
        const res = await request(app).get("/api/graph/schemas/unknown_head");
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Unknown node: "unknown_head"' });
    });

    it("returns the schema entry for a known head", async () => {
        const headIndex = new Map([
            ["all_events", makeMockCompiledNode("all_events", 0, {
                source: { isDeterministic: false, hasSideEffects: false },
            })],
        ]);
        const graph = makeMockInterface({ headIndex });
        const app = makeTestApp(graph);

        const res = await request(app).get("/api/graph/schemas/all_events");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            head: "all_events",
            arity: 0,
            output: "all_events",
            inputs: [],
            isDeterministic: false,
            hasSideEffects: false,
        });
    });
});

// ---------------------------------------------------------------------------
// GET /api/graph/nodes
// ---------------------------------------------------------------------------
describe("GET /api/graph/nodes", () => {
    it("returns 503 when graph is not initialized", async () => {
        const app = makeTestApp(null);
        const res = await request(app).get("/api/graph/nodes");
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: "Graph not yet initialized" });
    });

    it("returns empty array when no nodes are materialized", async () => {
        const graph = makeMockInterface();
        const app = makeTestApp(graph);
        const res = await request(app).get("/api/graph/nodes");
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("returns all materialized nodes with freshness but no values", async () => {
        const materialized = [
            ["all_events", []],
            ["event", ["evt-abc123"]],
        ];
        const freshness = new Map([
            [JSON.stringify({ head: "all_events", args: [] }), "up-to-date"],
            [JSON.stringify({ head: "event", args: ["evt-abc123"] }), "potentially-outdated"],
        ]);
        const timestamps = new Map([
            [JSON.stringify({ head: "all_events", args: [] }), { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-02T00:00:00.000Z" }],
            [JSON.stringify({ head: "event", args: ["evt-abc123"] }), { createdAt: "2024-01-03T00:00:00.000Z", modifiedAt: "2024-01-04T00:00:00.000Z" }],
        ]);
        const graph = makeMockInterface({ materialized, freshness, timestamps });
        const app = makeTestApp(graph);

        const res = await request(app).get("/api/graph/nodes");
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);

        const allEventsEntry = res.body.find((n) => n.head === "all_events");
        expect(allEventsEntry).toEqual({ head: "all_events", args: [], freshness: "up-to-date", createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-02T00:00:00.000Z" });
        expect(allEventsEntry).not.toHaveProperty("value");

        const eventEntry = res.body.find((n) => n.head === "event");
        expect(eventEntry).toEqual({ head: "event", args: ["evt-abc123"], freshness: "potentially-outdated", createdAt: "2024-01-03T00:00:00.000Z", modifiedAt: "2024-01-04T00:00:00.000Z" });
        expect(eventEntry).not.toHaveProperty("value");
    });

    it("includes null timestamps when timestamps are not recorded", async () => {
        const materialized = [["all_events", []]];
        const freshness = new Map([
            [JSON.stringify({ head: "all_events", args: [] }), "up-to-date"],
        ]);
        // no timestamps entry → debugGetTimestamps returns null
        const graph = makeMockInterface({ materialized, freshness });
        const app = makeTestApp(graph);

        const res = await request(app).get("/api/graph/nodes");
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0]).toEqual({ head: "all_events", args: [], freshness: "up-to-date", createdAt: null, modifiedAt: null });
    });

    it("excludes nodes with missing freshness", async () => {
        const materialized = [["all_events", []]];
        // freshness map has no entry for all_events → "missing"
        const graph = makeMockInterface({ materialized });
        const app = makeTestApp(graph);

        const res = await request(app).get("/api/graph/nodes");
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// GET /api/graph/nodes/:head
// ---------------------------------------------------------------------------
describe("GET /api/graph/nodes/:head", () => {
    it("returns 503 when graph is not initialized", async () => {
        const app = makeTestApp(null);
        const res = await request(app).get("/api/graph/nodes/all_events");
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: "Graph not yet initialized" });
    });

    it("returns 404 for unknown head", async () => {
        const graph = makeMockInterface();
        const app = makeTestApp(graph);
        const res = await request(app).get("/api/graph/nodes/unknown_head");
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Unknown node: "unknown_head"' });
    });

    describe("arity-0 node", () => {
        it("returns 404 when node is not yet materialized", async () => {
            const headIndex = new Map([["all_events", makeMockCompiledNode("all_events", 0)]]);
            const graph = makeMockInterface({ headIndex });
            const app = makeTestApp(graph);

            const res = await request(app).get("/api/graph/nodes/all_events");
            expect(res.status).toBe(404);
            expect(res.body).toEqual({ error: 'Node not materialized: "all_events"' });
        });

        it("returns the single materialized instance with its value", async () => {
            const headIndex = new Map([["all_events", makeMockCompiledNode("all_events", 0)]]);
            const freshness = new Map([
                [JSON.stringify({ head: "all_events", args: [] }), "up-to-date"],
            ]);
            const values = new Map([
                [JSON.stringify({ head: "all_events", args: [] }), { type: "all_events", events: [] }],
            ]);
            const timestamps = new Map([
                [JSON.stringify({ head: "all_events", args: [] }), { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-02T00:00:00.000Z" }],
            ]);
            const graph = makeMockInterface({ headIndex, freshness, values, timestamps });
            const app = makeTestApp(graph);

            const res = await request(app).get("/api/graph/nodes/all_events");
            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                head: "all_events",
                args: [],
                freshness: "up-to-date",
                value: { type: "all_events", events: [] },
                createdAt: "2024-01-01T00:00:00.000Z",
                modifiedAt: "2024-01-02T00:00:00.000Z",
            });
        });
    });

    describe("arity-N node", () => {
        it("returns empty list when no instances are materialized", async () => {
            const headIndex = new Map([["event", makeMockCompiledNode("event", 1)]]);
            const graph = makeMockInterface({ headIndex });
            const app = makeTestApp(graph);

            const res = await request(app).get("/api/graph/nodes/event");
            expect(res.status).toBe(200);
            expect(res.body).toEqual([]);
        });

        it("returns all instances for the head without values", async () => {
            const headIndex = new Map([["event", makeMockCompiledNode("event", 1)]]);
            const materialized = [
                ["event", ["evt-abc123"]],
                ["event", ["evt-def456"]],
            ];
            const freshness = new Map([
                [JSON.stringify({ head: "event", args: ["evt-abc123"] }), "up-to-date"],
                [JSON.stringify({ head: "event", args: ["evt-def456"] }), "potentially-outdated"],
            ]);
            const timestamps = new Map([
                [JSON.stringify({ head: "event", args: ["evt-abc123"] }), { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-02T00:00:00.000Z" }],
                [JSON.stringify({ head: "event", args: ["evt-def456"] }), { createdAt: "2024-01-03T00:00:00.000Z", modifiedAt: "2024-01-04T00:00:00.000Z" }],
            ]);
            const graph = makeMockInterface({ headIndex, materialized, freshness, timestamps });
            const app = makeTestApp(graph);

            const res = await request(app).get("/api/graph/nodes/event");
            expect(res.status).toBe(200);
            expect(res.body).toHaveLength(2);
            expect(res.body[0]).not.toHaveProperty("value");
            expect(res.body[1]).not.toHaveProperty("value");
            const sorted = [...res.body].sort((a, b) => a.args[0].localeCompare(b.args[0]));
            expect(sorted[0]).toEqual({ head: "event", args: ["evt-abc123"], freshness: "up-to-date", createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-02T00:00:00.000Z" });
            expect(sorted[1]).toEqual({ head: "event", args: ["evt-def456"], freshness: "potentially-outdated", createdAt: "2024-01-03T00:00:00.000Z", modifiedAt: "2024-01-04T00:00:00.000Z" });
        });
    });
});

// ---------------------------------------------------------------------------
// GET /api/graph/nodes/:head/:arg0[/:arg1...]
// ---------------------------------------------------------------------------
describe("GET /api/graph/nodes/:head/*", () => {
    it("returns 503 when graph is not initialized", async () => {
        const app = makeTestApp(null);
        const res = await request(app).get("/api/graph/nodes/event/evt-abc123");
        expect(res.status).toBe(503);
        expect(res.body).toEqual({ error: "Graph not yet initialized" });
    });

    it("returns 404 for unknown head", async () => {
        const graph = makeMockInterface();
        const app = makeTestApp(graph);
        const res = await request(app).get("/api/graph/nodes/unknown_head/arg1");
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Unknown node: "unknown_head"' });
    });

    it("returns 400 for arity mismatch (too many args)", async () => {
        const headIndex = new Map([["event", makeMockCompiledNode("event", 1)]]);
        const graph = makeMockInterface({ headIndex });
        const app = makeTestApp(graph);

        const res = await request(app).get("/api/graph/nodes/event/arg1/arg2");
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Arity mismatch: "event" expects 1 argument, got 2' });
    });

    it("returns 400 for arity mismatch (too few args)", async () => {
        const headIndex = new Map([
            ["pair", makeMockCompiledNode("pair", 2, { canonicalOutput: "pair(x,y)" })],
        ]);
        const graph = makeMockInterface({ headIndex });
        const app = makeTestApp(graph);

        const res = await request(app).get("/api/graph/nodes/pair/arg1");
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'Arity mismatch: "pair" expects 2 arguments, got 1' });
    });

    it("returns 404 when parameterized node is not materialized", async () => {
        const headIndex = new Map([["event", makeMockCompiledNode("event", 1)]]);
        const graph = makeMockInterface({ headIndex });
        const app = makeTestApp(graph);

        const res = await request(app).get("/api/graph/nodes/event/evt-abc123");
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'Node not materialized: "event(evt-abc123)"' });
    });

    it("returns the parameterized instance with its cached value", async () => {
        const headIndex = new Map([["event", makeMockCompiledNode("event", 1)]]);
        const freshness = new Map([
            [JSON.stringify({ head: "event", args: ["evt-abc123"] }), "up-to-date"],
        ]);
        const values = new Map([
            [JSON.stringify({ head: "event", args: ["evt-abc123"] }), { type: "event", id: "evt-abc123" }],
        ]);
        const timestamps = new Map([
            [JSON.stringify({ head: "event", args: ["evt-abc123"] }), { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-02T00:00:00.000Z" }],
        ]);
        const graph = makeMockInterface({ headIndex, freshness, values, timestamps });
        const app = makeTestApp(graph);

        const res = await request(app).get("/api/graph/nodes/event/evt-abc123");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            head: "event",
            args: ["evt-abc123"],
            freshness: "up-to-date",
            value: { type: "event", id: "evt-abc123" },
            createdAt: "2024-01-01T00:00:00.000Z",
            modifiedAt: "2024-01-02T00:00:00.000Z",
        });
    });

    it("handles multi-segment args", async () => {
        const headIndex = new Map([
            ["pair", makeMockCompiledNode("pair", 2, { canonicalOutput: "pair(x,y)" })],
        ]);
        const freshness = new Map([
            [JSON.stringify({ head: "pair", args: ["arg1", "arg2"] }), "up-to-date"],
        ]);
        const values = new Map([
            [JSON.stringify({ head: "pair", args: ["arg1", "arg2"] }), { result: "ok" }],
        ]);
        const timestamps = new Map([
            [JSON.stringify({ head: "pair", args: ["arg1", "arg2"] }), { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" }],
        ]);
        const graph = makeMockInterface({ headIndex, freshness, values, timestamps });
        const app = makeTestApp(graph);

        const res = await request(app).get("/api/graph/nodes/pair/arg1/arg2");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            head: "pair",
            args: ["arg1", "arg2"],
            freshness: "up-to-date",
            value: { result: "ok" },
            createdAt: "2024-01-01T00:00:00.000Z",
            modifiedAt: "2024-01-01T00:00:00.000Z",
        });
    });
});
