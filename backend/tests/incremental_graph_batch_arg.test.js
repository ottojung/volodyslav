/**
 * Tests for the optional batch argument on pull() and invalidate().
 *
 * Contract:
 *   pull(nodeName, bindings, batch)    — ALL writes (including recursive dependency pulls)
 *                                        go into `batch`; nothing is committed until `batch`
 *                                        commits.
 *   invalidate(nodeName, bindings, batch) — same for invalidate.
 *   pull(nodeName) / invalidate(nodeName) — original semantics preserved: each node's writes
 *                                           are committed in their own independent batch.
 *
 * Critical semantic divergence that these tests guard against:
 *   The BROKEN implementation shares the internal withBatch with recursive calls even when
 *   no external batch was provided.  Consequences:
 *     1. (External batch) pull() ignores the provided batch and commits independently → the
 *        caller cannot prevent the commit by aborting the batch.
 *     2. (No external batch) when derived's computor fails, source's writes are rolled back
 *        together with derived's, even though source finished successfully first.
 *   The CORRECT implementation:
 *     1. With external batch → every recursive pull/invalidate shares that one batch.
 *     2. Without external batch → every recursive pull opens its own fresh batch (original).
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { makeIncrementalGraph } = require("../src/generators/incremental_graph");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    fs.mkdtempSync(path.join(os.tmpdir(), "incremental-graph-batch-arg-"));
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return capabilities;
}

const A_SOURCE_VALUE = { type: "all_events", events: [] };
const A_DERIVED_VALUE = { type: "meta_events", meta_events: [] };

// Serialised NodeKey strings that match serializeNodeKey's output.
const KEY_SOURCE  = '{"head":"source","args":[]}';
const KEY_DERIVED = '{"head":"derived","args":[]}';

async function makeSourceGraph(computor = undefined) {
    const db = await getRootDatabase(getTestCapabilities());
    const graph = makeIncrementalGraph(db, [
        {
            output: "source",
            inputs: [],
            computor: computor ?? (async () => A_SOURCE_VALUE),
            isDeterministic: true,
            hasSideEffects: false,
        },
    ]);
    return { db, graph, storage: graph.getStorage() };
}

async function makeChainGraph({ sourceComputor, derivedComputor } = {}) {
    const db = await getRootDatabase(getTestCapabilities());
    const graph = makeIncrementalGraph(db, [
        {
            output: "source",
            inputs: [],
            computor: sourceComputor ?? (async () => A_SOURCE_VALUE),
            isDeterministic: true,
            hasSideEffects: false,
        },
        {
            output: "derived",
            inputs: ["source"],
            computor: derivedComputor ?? (async () => A_DERIVED_VALUE),
            isDeterministic: true,
            hasSideEffects: false,
        },
    ]);
    return { db, graph, storage: graph.getStorage() };
}

// ===========================================================================
// I.  Divergence tests — these FAIL with the broken implementation
// ===========================================================================

describe("incremental_graph — batch argument: core divergence tests", () => {

    test("pull with external batch: writes are NOT committed until the batch commits", async () => {
        // When an external batch is aborted (throws before committing), no writes should
        // reach the DB.  A broken implementation commits via its own internal withBatch
        // and the abort of the outer batch has no effect.
        const { db, graph, storage } = await makeSourceGraph();

        let freshnessInOverlay;

        await expect(
            storage.withBatch(async (batch) => {
                await graph.pull("source", [], batch);
                // The write must be visible immediately in the batch overlay.
                freshnessInOverlay = await batch.freshness.get(KEY_SOURCE);
                throw new Error("abort-batch");
            })
        ).rejects.toThrow("abort-batch");

        // Write was visible inside the overlay (read-your-writes in the batch).
        expect(freshnessInOverlay).toBe("up-to-date");

        // The batch was aborted → nothing reached the DB.
        expect(await graph.debugGetFreshness("source")).toBe("missing");

        await db.close();
    });

    test("derived chain with external batch: neither node is committed when batch is aborted", async () => {
        // Pulling a derived node internally pulls source too.  Both pulls must stay
        // inside the external batch.  A broken implementation commits source independently,
        // so source survives the abort.
        const { db, graph, storage } = await makeChainGraph();

        await expect(
            storage.withBatch(async (batch) => {
                await graph.pull("derived", [], batch);
                throw new Error("abort-chain");
            })
        ).rejects.toThrow("abort-chain");

        expect(await graph.debugGetFreshness("source")).toBe("missing");
        expect(await graph.debugGetFreshness("derived")).toBe("missing");

        await db.close();
    });

    test("invalidate with external batch: change is NOT committed when batch is aborted", async () => {
        // Same principle for invalidate: writes must live in the external batch.
        const { db, graph, storage } = await makeSourceGraph();

        await graph.pull("source"); // make it up-to-date in DB

        let freshnessInOverlay;

        await expect(
            storage.withBatch(async (batch) => {
                await graph.invalidate("source", [], batch);
                freshnessInOverlay = await batch.freshness.get(KEY_SOURCE);
                throw new Error("abort-invalidate");
            })
        ).rejects.toThrow("abort-invalidate");

        // Overlay had the new freshness.
        expect(freshnessInOverlay).toBe("potentially-outdated");

        // DB retains the previous committed state.
        expect(await graph.debugGetFreshness("source")).toBe("up-to-date");

        await db.close();
    });

    test("plain pull (no batch): when derived computor fails, source remains independently committed", async () => {
        // Without an external batch, each pull is its own atomic commit.  Source commits
        // first in its own batch; if derived's computor then throws, derived's batch is
        // abandoned but source's commit stands.
        // A broken implementation bundles both in one batch → source is never committed.
        let sourceComputations = 0;

        const { db, graph } = await makeChainGraph({
            sourceComputor: async () => {
                sourceComputations++;
                return A_SOURCE_VALUE;
            },
            derivedComputor: async () => {
                throw new Error("derived-fails");
            },
        });

        await expect(graph.pull("derived")).rejects.toThrow("derived-fails");

        // Source computor ran once.
        expect(sourceComputations).toBe(1);

        // Source committed independently → it is up-to-date in DB.
        expect(await graph.debugGetFreshness("source")).toBe("up-to-date");

        // Pulling source again returns the cached value without recomputation.
        expect(await graph.pull("source")).toEqual(A_SOURCE_VALUE);
        expect(sourceComputations).toBe(1); // no extra compute

        await db.close();
    });
});

// ===========================================================================
// II.  External batch — full feature contract
// ===========================================================================

describe("incremental_graph — pull() with external batch: feature contract", () => {

    test("writes are committed and visible after the batch commits", async () => {
        const { db, graph, storage } = await makeSourceGraph();

        await storage.withBatch(async (batch) => {
            await graph.pull("source", [], batch);
        });

        expect(await graph.debugGetFreshness("source")).toBe("up-to-date");
        expect(await graph.pull("source")).toEqual(A_SOURCE_VALUE);

        await db.close();
    });

    test("source and derived both become up-to-date inside the batch overlay", async () => {
        const computeCalls = [];
        const { db, graph, storage } = await makeChainGraph({
            sourceComputor: async () => { computeCalls.push("source"); return A_SOURCE_VALUE; },
            derivedComputor: async () => { computeCalls.push("derived"); return A_DERIVED_VALUE; },
        });

        let sourceFreshnessInBatch;
        let derivedFreshnessInBatch;

        await storage.withBatch(async (batch) => {
            await graph.pull("derived", [], batch);
            sourceFreshnessInBatch = await batch.freshness.get(KEY_SOURCE);
            derivedFreshnessInBatch = await batch.freshness.get(KEY_DERIVED);
        });

        expect(computeCalls).toEqual(["source", "derived"]);
        expect(sourceFreshnessInBatch).toBe("up-to-date");
        expect(derivedFreshnessInBatch).toBe("up-to-date");
        expect(await graph.debugGetFreshness("source")).toBe("up-to-date");
        expect(await graph.debugGetFreshness("derived")).toBe("up-to-date");

        await db.close();
    });

    test("read-your-writes: second pull in same batch sees result of first pull", async () => {
        // After pull("source", [], batch), source is up-to-date in the batch overlay.
        // A subsequent pull("derived", [], batch) must see that and NOT recompute source.
        const computeCalls = [];
        const db = await getRootDatabase(getTestCapabilities());
        const graph = makeIncrementalGraph(db, [
            { output: "source",  inputs: [],         computor: async () => { computeCalls.push("source");  return A_SOURCE_VALUE;  }, isDeterministic: true, hasSideEffects: false },
            { output: "derived", inputs: ["source"], computor: async () => { computeCalls.push("derived"); return A_DERIVED_VALUE; }, isDeterministic: true, hasSideEffects: false },
        ]);
        const storage = graph.getStorage();

        await storage.withBatch(async (batch) => {
            await graph.pull("source", [], batch);   // materialises source in overlay
            await graph.pull("derived", [], batch);  // must see source as up-to-date
        });

        expect(computeCalls.filter((c) => c === "source").length).toBe(1);
        expect(computeCalls).toContain("derived");

        await db.close();
    });

    test("two nodes sharing an input: shared input computor runs only once per batch", async () => {
        const computeCalls = [];
        const db = await getRootDatabase(getTestCapabilities());
        const graph = makeIncrementalGraph(db, [
            { output: "source", inputs: [],         computor: async () => { computeCalls.push("source"); return A_SOURCE_VALUE;  }, isDeterministic: true, hasSideEffects: false },
            { output: "a",      inputs: ["source"], computor: async () => { computeCalls.push("a");      return A_DERIVED_VALUE; }, isDeterministic: true, hasSideEffects: false },
            { output: "b",      inputs: ["source"], computor: async () => { computeCalls.push("b");      return A_DERIVED_VALUE; }, isDeterministic: true, hasSideEffects: false },
        ]);
        const storage = graph.getStorage();

        await storage.withBatch(async (batch) => {
            await graph.pull("a", [], batch);
            await graph.pull("b", [], batch);
        });

        // source was already up-to-date in the overlay when "b" tried to pull it.
        expect(computeCalls.filter((c) => c === "source").length).toBe(1);
        expect(computeCalls).toContain("a");
        expect(computeCalls).toContain("b");

        await db.close();
    });
});

// ===========================================================================
// III.  External batch — invalidate() contract
// ===========================================================================

describe("incremental_graph — invalidate() with external batch: feature contract", () => {

    test("invalidate commits freshness change when batch commits", async () => {
        const { db, graph, storage } = await makeSourceGraph();

        await graph.pull("source");

        await storage.withBatch(async (batch) => {
            await graph.invalidate("source", [], batch);
        });

        expect(await graph.debugGetFreshness("source")).toBe("potentially-outdated");

        await db.close();
    });

    test("invalidate propagates outdatedness to dependents inside the batch overlay", async () => {
        const { db, graph, storage } = await makeChainGraph();

        await graph.pull("derived"); // materialise both nodes

        let sourceFreshness;
        let derivedFreshness;

        await storage.withBatch(async (batch) => {
            await graph.invalidate("source", [], batch);
            sourceFreshness = await batch.freshness.get(KEY_SOURCE);
            derivedFreshness = await batch.freshness.get(KEY_DERIVED);
        });

        expect(sourceFreshness).toBe("potentially-outdated");
        expect(derivedFreshness).toBe("potentially-outdated");
        expect(await graph.debugGetFreshness("source")).toBe("potentially-outdated");
        expect(await graph.debugGetFreshness("derived")).toBe("potentially-outdated");

        await db.close();
    });
});

// ===========================================================================
// IV.  Combined invalidate() + pull() in one batch
// ===========================================================================

describe("incremental_graph — combined invalidate() + pull() in one batch", () => {

    test("invalidate then pull in same batch recomputes atomically", async () => {
        let callCount = 0;
        const { db, graph, storage } = await makeSourceGraph(async () => {
            callCount++;
            return { n: callCount };
        });

        const v1 = await graph.pull("source");
        expect(v1).toEqual({ n: 1 });

        let v2;
        await storage.withBatch(async (batch) => {
            await graph.invalidate("source", [], batch);
            v2 = await graph.pull("source", [], batch);
        });

        expect(callCount).toBe(2);
        expect(v2).toEqual({ n: 2 });

        // After commit, a plain pull uses the newly cached value.
        expect(await graph.pull("source")).toEqual({ n: 2 });
        expect(callCount).toBe(2); // no extra recomputation

        await db.close();
    });
});

// ===========================================================================
// V.  Plain pull() / invalidate() — original semantics preserved
// ===========================================================================

describe("incremental_graph — plain pull() and invalidate() (no batch, original semantics)", () => {

    test("pull computes and caches the value", async () => {
        const { db, graph } = await makeSourceGraph();

        expect(await graph.pull("source")).toEqual(A_SOURCE_VALUE);
        expect(await graph.debugGetFreshness("source")).toBe("up-to-date");

        await db.close();
    });

    test("second pull returns cached value without recomputation", async () => {
        let callCount = 0;
        const { db, graph } = await makeSourceGraph(async () => { callCount++; return A_SOURCE_VALUE; });

        await graph.pull("source");
        await graph.pull("source");
        expect(callCount).toBe(1);

        await db.close();
    });

    test("pull of derived chain computes dependencies in order", async () => {
        const computeCalls = [];
        const { db, graph } = await makeChainGraph({
            sourceComputor: async () => { computeCalls.push("source"); return A_SOURCE_VALUE; },
            derivedComputor: async ([src]) => { computeCalls.push("derived"); return { ...A_DERIVED_VALUE, source: src }; },
        });

        const v = await graph.pull("derived");
        expect(computeCalls).toEqual(["source", "derived"]);
        expect(v.source).toEqual(A_SOURCE_VALUE);

        await db.close();
    });

    test("after pull of derived, pulling source returns cached value without recomputation", async () => {
        const computeCalls = [];
        const { db, graph } = await makeChainGraph({
            sourceComputor: async () => { computeCalls.push("source"); return A_SOURCE_VALUE; },
            derivedComputor: async () => { computeCalls.push("derived"); return A_DERIVED_VALUE; },
        });

        await graph.pull("derived");
        await graph.pull("source"); // already up-to-date
        expect(computeCalls.filter((c) => c === "source").length).toBe(1);

        await db.close();
    });

    test("invalidate marks node outdated and forces recomputation on next pull", async () => {
        let callCount = 0;
        const { db, graph } = await makeSourceGraph(async () => { callCount++; return { n: callCount }; });

        const v1 = await graph.pull("source");
        expect(v1).toEqual({ n: 1 });

        await graph.invalidate("source");
        expect(await graph.debugGetFreshness("source")).toBe("potentially-outdated");

        const v2 = await graph.pull("source");
        expect(v2).toEqual({ n: 2 });
        expect(callCount).toBe(2);

        await db.close();
    });

    test("invalidate propagates to dependents already materialized", async () => {
        const { db, graph } = await makeChainGraph();

        await graph.pull("derived");

        await graph.invalidate("source");

        expect(await graph.debugGetFreshness("source")).toBe("potentially-outdated");
        expect(await graph.debugGetFreshness("derived")).toBe("potentially-outdated");

        await db.close();
    });
});
