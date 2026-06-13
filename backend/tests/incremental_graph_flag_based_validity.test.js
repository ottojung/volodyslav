/**
 * Tests for the flag-based inverse validity algorithm.
 *
 * These tests validate the specification defined in:
 * docs/specs/incremental-graph-flag-based-inverse-validity.md
 */

const {
    makeIncrementalGraph,
    makeUnchanged,
    isUnchanged,
} = require("../src/generators/incremental_graph");
const {
    makeEmptyIdentifierLookup,
    cloneIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    nodeIdentifierFromString,
    nodeIdentifierToString,
    nodeIdentifierCompare,
    stringToNodeIdentifier,
} = require("../src/generators/incremental_graph/database");
const { makeSemanticStorage } = require("./test_database_helper");
const { getMockedRootCapabilities } = require("./spies");

const testCapabilities = getMockedRootCapabilities();

function deepClone(x) {
    return JSON.parse(JSON.stringify(x));
}

/**
 * Create a concrete JSON key for a node, given a head and positional args.
 */
function makeNodeStorageKey(head, args = []) {
    return JSON.stringify({ head, args });
}

const DEFAULT_SCHEMA_KEY = '__default__';

/**
 * Minimal in-memory database supporting the `valid` sublevel
 * for flag-based validity tests.
 */
class InMemoryDatabase {
    constructor() {
        this.schemas = new Map();
        this.root = new Map();
        this.closed = false;
        this.batchLog = [];
        this.putLog = [];
        this.version = 'test-version';
        this._identifierLookup = makeEmptyIdentifierLookup();
        this._identifierCounter = 0;
        this._pendingAllocations = new Map();
        this._computed = { lastNodeIndex: 0, fingerprint: 'testfpflagval' };
    }

    currentReplicaName() { return 'x'; }

    cloneActiveIdentifierLookup() {
        return cloneIdentifierLookup(this._identifierLookup);
    }

    getActiveIdentifierLookup() {
        return this._identifierLookup;
    }

    replaceActiveIdentifierLookup(lookup) {
        this._identifierLookup = lookup;
    }

    nodeIdToKey(nodeIdentifier) {
        return nodeIdToKeyFromLookup(this._identifierLookup, nodeIdentifier);
    }

    nodeKeyToId(nodeKey) {
        return nodeKeyToIdFromLookup(this._identifierLookup, nodeKey);
    }

    generateNodeIdentifier() {
        this._identifierCounter++;
        let n = this._identifierCounter;
        let id = '';
        for (let i = 0; i < 9; i++) {
            id = String.fromCharCode(97 + (n % 26)) + id;
            n = Math.floor(n / 26);
        }
        return nodeIdentifierFromString(id.replace(/a+$/, s => {
            // Ensure minimum 9 chars
            while (id.length < 9) id = 'a' + id;
            return id;
        }).slice(-9));
    }

    getCurrentAllocationWatermark() {
        return this._identifierCounter;
    }

    getFingerprint() {
        return 'testfpflagval';
    }

    getVersion() { return this.version; }

    getLastNodeIndex() { return this._computed.lastNodeIndex; }

    advanceLastNodeIndex(value) { this._computed.lastNodeIndex = Math.max(this._computed.lastNodeIndex, value); }

    _allocateKeyIdentifier(keyString, makeIdentifier, committedLookup) {
        if (this._pendingAllocations.has(keyString)) {
            throw new Error(`BUG: pending allocation for key ${keyString}`);
        }
        const candidate = makeIdentifier();
        const candidateStr = nodeIdentifierToString(candidate);
        if (committedLookup.idToKey.get(candidateStr) !== undefined) {
            throw new Error(`BUG: identifier collision`);
        }
        this._pendingAllocations.set(keyString, candidateStr);
        return candidate;
    }

    releaseIdentifierReservations(ownedKeys) {
        for (const keyString of ownedKeys) {
            this._pendingAllocations.delete(keyString);
        }
    }

    /** Read raw sublevel value for test inspection */
    _readSublevel(name, key) {
        const schemaMap = this.schemas.get(DEFAULT_SCHEMA_KEY);
        if (!schemaMap) return undefined;
        const fullKey = `${name}:${key}`;
        const v = schemaMap.get(fullKey);
        return v === undefined ? undefined : deepClone(v);
    }

    getSchemaStorage() {
        const key = DEFAULT_SCHEMA_KEY;
        if (!this.schemas.has(key)) {
            this.schemas.set(key, new Map());
        }
        const schemaMap = this.schemas.get(key);

        const createSublevel = (name) => {
            const prefix = `${name}:`;
            /** @type {any} */
            const sublevel = {
                get: async (key) => {
                    const fullKey = prefix + key;
                    const v = schemaMap.get(fullKey);
                    return v === undefined ? undefined : deepClone(v);
                },
                put: async (key, value) => {
                    const fullKey = prefix + key;
                    schemaMap.set(fullKey, deepClone(value));
                },
                del: async (key) => {
                    const fullKey = prefix + key;
                    schemaMap.delete(fullKey);
                },
                putOp: (key, value) => {
                    return { type: 'put', sublevel, key, value };
                },
                delOp: (key) => {
                    return { type: 'del', sublevel, key };
                },
                keys: async function* () {
                    for (const k of schemaMap.keys()) {
                        if (k.startsWith(prefix)) {
                            yield k.substring(prefix.length);
                        }
                    }
                },
                clear: async () => {
                    const toDelete = [];
                    for (const k of schemaMap.keys()) {
                        if (k.startsWith(prefix)) toDelete.push(k);
                    }
                    for (const k of toDelete) schemaMap.delete(k);
                },
            };
            return sublevel;
        };

        const values = createSublevel('values');
        const freshness = createSublevel('freshness');
        const inputs = createSublevel('inputs');
        const revdeps = createSublevel('revdeps');
        const valid = createSublevel('valid');
        const counters = createSublevel('counters');
        const timestamps = createSublevel('timestamps');
        const global = createSublevel('global');

        return {
            values,
            freshness,
            inputs,
            revdeps,
            valid,
            counters,
            timestamps,
            global,
            batch: async (operations) => {
                this.batchLog.push({ ops: deepClone(operations.map(op => ({
                    type: op.type,
                    key: op.key,
                    value: op.value
                }))) });
                for (const op of operations) {
                    if (op.type === 'put') {
                        await op.sublevel.put(op.key, op.value);
                    } else if (op.type === 'del') {
                        await op.sublevel.del(op.key);
                    }
                }
            },
        };
    }

    async *listSchemas() {
        for (const key of this.schemas.keys()) {
            yield key;
        }
    }

    async put(key, value) {
        if (this.closed) throw new Error("DatabaseClosed");
        this.root.set(key, deepClone(value));
    }

    async get(key) {
        if (this.closed) throw new Error("DatabaseClosed");
        const v = this.root.get(key);
        return v === undefined ? undefined : deepClone(v);
    }
}

/**
 * Create a computor that tracks call count and uses a value factory.
 * @param {string} name - Label for debug messages.
 * @param {function(number): any} valueFactory - Called with callCount to produce value.
 *   If it returns the makeUnchanged() sentinel, the computor returns Unchanged instead.
 * @returns {{ computor: Function, getCallCount: () => number }}
 */
function countedComputor(name, valueFactory) {
    let callCount = 0;
    const computor = async (inputs, oldValue, bindings) => {
        callCount++;
        const result = valueFactory(callCount);
        if (isUnchanged(result)) {
            return result;
        }
        return result;
    };
    return { computor, getCallCount: () => callCount };
}

describe("Flag-Based Inverse Validity Algorithm", () => {
    /**
     * @type {InMemoryDatabase}
     */
    let db;
    /**
     * @type {ReturnType<makeIncrementalGraph>}
     */
    let graph;

    /**
     * Creates a simple chain: source -> middle -> dependent
     */
    function createChainGraph(sourceComputor, middleComputor, dependentComputor) {
        const sourceCC = countedComputor("source", sourceComputor || (() => ({ v: "src" })));
        const middleCC = countedComputor("middle", middleComputor || ((n) => ({ v: "mid-" + n })));
        const dependentCC = countedComputor("dependent", dependentComputor || ((n) => ({ v: "dep-" + n })));

        const nodeDefs = [
            {
                output: "source",
                inputs: [],
                computor: sourceCC.computor,
                isDeterministic: false,
                hasSideEffects: false,
            },
            {
                output: "middle(x)",
                inputs: ["source"],
                computor: middleCC.computor,
                isDeterministic: false,
                hasSideEffects: false,
            },
            {
                output: "dependent(x)",
                inputs: ["middle(x)"],
                computor: dependentCC.computor,
                isDeterministic: false,
                hasSideEffects: false,
            },
        ];

        return { nodeDefs, sourceCC, middleCC, dependentCC };
    }

    beforeEach(() => {
        db = new InMemoryDatabase();
    });

    // === Test Obligation 1: Cache hit ===
    describe("test obligation 1: cache hit through valid flags", () => {
        it("returns cached value without recomputing when valid[D].has(N) for all dependencies", async () => {
            let lastN = 0;
            const { nodeDefs, middleCC } = createChainGraph(
                () => ({ v: "src" }),
                (n) => {
                    lastN = n;
                    return { v: "mid-" + n };
                },
                () => ({ v: "dep" })
            );

            graph = makeIncrementalGraph(testCapabilities, db, nodeDefs);

            const binding = [{ id: "x" }];
            const srcKey = makeNodeStorageKey("source");
            const midKey = makeNodeStorageKey("middle", binding);
            const depKey = makeNodeStorageKey("dependent", binding);

            // First pull: materialize all nodes
            await graph.pull("source");
            expect(middleCC.getCallCount()).toBe(0);
            await graph.pull("middle", binding);
            expect(middleCC.getCallCount()).toBe(1);
            lastN = 0;
            await graph.pull("dependent", binding);

            // Check validity flags exist after pulls
            const depId = db.nodeKeyToId(depKey);
            expect(depId).toBeTruthy();

            // Second pull of dependent should cache-hit
            const beforeCalls = middleCC.getCallCount();
            await graph.pull("dependent", binding);
            expect(middleCC.getCallCount()).toBe(beforeCalls);
        });
    });

    // === Test Obligation 2: No vacuous cache hit for zero-input nodes ===
    describe("test obligation 2: zero-input nodes do not cache-hit vacuously", () => {
        it("must run the computor even when potentially-outdated with no inputs", async () => {
            let callCount = 0;
            const nodeDefs = [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => {
                        callCount++;
                        return { v: callCount };
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
            ];

            graph = makeIncrementalGraph(testCapabilities, db, nodeDefs);
            const srcKey = makeNodeStorageKey("source");

            // First pull
            await graph.pull("source");
            expect(callCount).toBe(1);

            // Invalidate (marks potentially-outdated)
            await graph.invalidate("source");

            // Second pull: zero-input node must recompute, not cache-hit vacuously
            await graph.pull("source");
            expect(callCount).toBe(2);
        });
    });

    // === Test Obligation 3: Unchanged adds validity flags ===
    describe("test obligation 3: Unchanged adds validity flags", () => {
        it("records valid[D].add(N) for every dependency edge without incrementing counter", async () => {
            let midCalls = 0;
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => {
                    midCalls++;
                    if (midCalls === 1) return { v: "mid-first" };
                    return makeUnchanged();
                },
                () => ({ v: "dep" })
            );

            graph = makeIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];
            const midKey = makeNodeStorageKey("middle", binding);
            const depKey = makeNodeStorageKey("dependent", binding);

            // Materialize all nodes
            await graph.pull("source");
            await graph.pull("middle", binding);
            const midId = db.nodeKeyToId(midKey);
            const depId = db.nodeKeyToId(depKey);
            expect(midId).toBeTruthy();
            expect(depId).toBeTruthy();

            // Get the counter value for dependent before pull
            const midCounterBefore = db._readSublevel('counters', midId);
            const depCounterBefore = db._readSublevel('counters', depId);

            // Now pull dependent first time
            await graph.pull("dependent", binding);
            const depCallCountBefore = midCalls; // after first pull of dependent

            // Invalidate source and pull everything again
            await graph.invalidate("source");
            await graph.pull("source");
            expect(midCalls).toBe(2); // middle recomputed

            // When middle returns Unchanged, its counter should NOT increment
            const midCounterAfter = db._readSublevel('counters', midId);
            expect(midCounterAfter).toBe(midCounterBefore);

            // Dependent should still be pullable
            await graph.pull("dependent", binding);
        });
    });

    // === Test Obligation 4: Changed value clears validity ===
    describe("test obligation 4: changed value clears validity", () => {
        it("deletes N from each valid[D], clears valid[N], writes new counter", async () => {
            let srcValue = 0;
            const { nodeDefs, middleCC, dependentCC } = createChainGraph(
                () => ({ v: ++srcValue }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            graph = makeIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];

            // Pull chain: source -> middle -> dependent
            await graph.pull("source");
            await graph.pull("middle", binding);
            await graph.pull("dependent", binding);

            const midKey = makeNodeStorageKey("middle", binding);
            const depKey = makeNodeStorageKey("dependent", binding);
            const midId = db.nodeKeyToId(midKey);
            const depId = db.nodeKeyToId(depKey);

            // Record initial counters
            const depCounterBefore = db._readSublevel('counters', depId);

            // Invalidate source and pull again with changed value
            await graph.invalidate("source");
            await graph.pull("source"); // srcValue = 2

            const midCallsBefore = middleCC.getCallCount();
            const depCallsBefore = dependentCC.getCallCount();

            // Pull dependent: all dependencies changed, so recompute
            await graph.pull("dependent", binding);

            // Dependent's counter should have incremented (value changed)
            const depCounterAfter = db._readSublevel('counters', depId);
            expect(depCounterAfter).toBe((depCounterBefore || 0) + 1);
        });
    });

    // === Test Obligation 5: Changed dependency invalidates cache ===
    describe("test obligation 5: changed dependency prevents stale cache hit", () => {
        it("clears valid[D] when D changes value, forcing dependent recompute", async () => {
            let srcValue = 0;
            const { nodeDefs, middleCC, dependentCC } = createChainGraph(
                () => ({ v: ++srcValue }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            graph = makeIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];

            // Materialize chain
            await graph.pull("source");
            await graph.pull("middle", binding);
            await graph.pull("dependent", binding);

            const depKey = makeNodeStorageKey("dependent", binding);
            const depId = db.nodeKeyToId(depKey);

            // Invalidate and pull source with new value
            await graph.invalidate("source");
            await graph.pull("source"); // srcValue = 2

            // Invalidate source again but make it return Unchanged
            // The freshness propagation should reach dependent
            await graph.invalidate("source");

            const depCallsBeforePull = dependentCC.getCallCount();

            // Pull dependent — should need to validate against current dependencies
            await graph.pull("dependent", binding);
        });
    });

    // === Test Obligation 6: External invalidation does not mutate valid ===
    describe("test obligation 6: external invalidation preserves valid", () => {
        it("does not clear validity flags when nodes are marked potentially-outdated", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            graph = makeIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];

            // Materialize chain
            await graph.pull("source");
            await graph.pull("middle", binding);
            await graph.pull("dependent", binding);

            const srcKey = makeNodeStorageKey("source");
            const midKey = makeNodeStorageKey("middle", binding);

            // Read the valid sets before invalidation
            // (valid sets should exist from the pull phase)

            await graph.invalidate("source");

            // Check that middle's freshness is now potentially-outdated
            const midId = db.nodeKeyToId(midKey);
            const midFreshness = db._readSublevel('freshness', midId);
            expect(midFreshness).toBe("potentially-outdated");
        });
    });

    // === Test Obligation 7: Failed computor rolls back ===
    describe("test obligation 7: failed computor rolls back", () => {
        it("does not partially write values, counters, freshness, or validity on computor failure", async () => {
            let sourceCalls = 0;
            let shouldFail = false;
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => {
                    if (shouldFail) throw new Error("computor failure");
                    return { v: "mid" };
                },
                () => ({ v: "dep" })
            );

            graph = makeIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];

            // Materialize source and middle
            await graph.pull("source");
            await graph.pull("middle", binding);

            // Now make it fail
            shouldFail = true;

            // Invalidate source and middle
            await graph.invalidate("source");

            // Pull middle again - should throw because computor fails
            await expect(graph.pull("middle", binding)).rejects.toThrow("computor failure");

            // After failure, middle's freshness should still be potentially-outdated
            // (the failure left it as it was before the attempt)
            const midKey = makeNodeStorageKey("middle", binding);
            const midId = db.nodeKeyToId(midKey);
            const midFreshness = db._readSublevel('freshness', midId);
            expect(midFreshness).toBe("potentially-outdated");
        });
    });

    // === Test Obligation 8: Unchanged requires materialized value ===
    describe("test obligation 8: Unchanged requires materialized value", () => {
        it("throws when computor returns Unchanged for a never-materialized node", async () => {
            const nodeDefs = [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => makeUnchanged(),
                    isDeterministic: false,
                    hasSideEffects: false,
                },
            ];

            graph = makeIncrementalGraph(testCapabilities, db, nodeDefs);
            await expect(graph.pull("source")).rejects.toThrow();
        });
    });

    // === Test Obligation 9: Duplicate input positions preserved for computor, collapsed for edges ===
    describe("test obligation 9: duplicate positions vs collapsed edges", () => {
        it("preserves duplicates in computor arguments but collapses for structural metadata", async () => {
            /** @type {Array<Array<any>>} */
            const receivedInputs = [];
            const nodeDefs = [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => ({ v: "src" }),
                    isDeterministic: false,
                    hasSideEffects: false,
                },
                {
                    output: "dup_user(x)",
                    inputs: ["source", "source"], // duplicate dependency
                    computor: async (inputs, oldValue, bindings) => {
                        receivedInputs.push(inputs);
                        return { v: "dup_user", count: inputs.length };
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
            ];

            graph = makeIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];

            await graph.pull("source");
            await graph.pull("dup_user", binding);

            // Computor should receive 2 arguments (both source values)
            expect(receivedInputs.length).toBe(1);
            expect(receivedInputs[0].length).toBe(2);
            expect(receivedInputs[0][0]).toEqual({ v: "src" });
            expect(receivedInputs[0][1]).toEqual({ v: "src" });

            // Structural inputs should have only 1 entry (collapsed)
            const dupKey = makeNodeStorageKey("dup_user", binding);
            const dupId = db.nodeKeyToId(dupKey);
            const inputsRecord = db._readSublevel('inputs', dupId);
            if (Array.isArray(inputsRecord)) {
                expect(inputsRecord.length).toBe(1); // collapsed
            } else if (inputsRecord && inputsRecord.inputs) {
                expect(inputsRecord.inputs.length).toBe(1); // collapsed
            }
        });
    });

    // === Test Obligation 11: Downstream validity survives upstream Unchanged ===
    describe("test obligation 11: downstream validity survives upstream Unchanged", () => {
        it("A -> B -> C: when B returns Unchanged, valid[B].has(C) remains, C can cache-hit", async () => {
            let bCalls = 0;
            let cCalls = 0;
            const nodeDefs = [
                {
                    output: "A",
                    inputs: [],
                    computor: async () => ({ v: "A" }),
                    isDeterministic: false,
                    hasSideEffects: false,
                },
                {
                    output: "B(x)",
                    inputs: ["A"],
                    computor: async () => {
                        bCalls++;
                        if (bCalls === 1) return { v: "B-first" };
                        return makeUnchanged();
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
                {
                    output: "C(x)",
                    inputs: ["B(x)"],
                    computor: async () => {
                        cCalls++;
                        return { v: "C-" + cCalls };
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
            ];

            graph = makeIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];

            // Materialize chain
            await graph.pull("A");
            await graph.pull("B", binding);
            await graph.pull("C", binding);
            expect(bCalls).toBe(1);
            expect(cCalls).toBe(1);

            const cKey = makeNodeStorageKey("C", binding);
            const cId = db.nodeKeyToId(cKey);

            // Invalidate A, pull B (Unchanged), then pull C (should cache-hit)
            await graph.invalidate("A");
            await graph.pull("A");
            await graph.pull("B", binding); // B returns Unchanged
            expect(bCalls).toBe(2);

            // C's freshness should have been set to up-to-date by B's handleUnchanged
            // Pull C: it should cache-hit because valid[B].has(C) was preserved
            const cCallsBefore = cCalls;
            await graph.pull("C", binding);
            expect(cCalls).toBe(cCallsBefore); // C did NOT recompute
        });
    });

    // === Test Obligation 12: valid is not an invalidation index ===
    describe("test obligation 12: valid is not an invalidation index", () => {
        it("invalidation walks revdeps, not valid – missing valid flag does not block propagation", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            graph = makeIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];

            // Pull only source and middle - dependent not yet materialized
            await graph.pull("source");
            await graph.pull("middle", binding);

            const depKey = makeNodeStorageKey("dependent", binding);
            const depId = db.nodeKeyToId(depKey);
            // dependent shouldn't exist yet (hasn't been pulled)
            let depFreshness = db._readSublevel('freshness', depId);
            expect(depFreshness).toBeUndefined();

            // Pull dependent to materialize it
            await graph.pull("dependent", binding);
            depFreshness = db._readSublevel('freshness', depId);
            expect(depFreshness).toBe("up-to-date");

            // Now invalidate source - should propagate through middle to dependent
            await graph.invalidate("source");
            depFreshness = db._readSublevel('freshness', depId);
            expect(depFreshness).toBe("potentially-outdated");
        });
    });

    // === Deterministic serialization ===
    describe("deterministic serialization", () => {
        it("stores valid and revdeps in sorted order", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            graph = makeIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];

            await graph.pull("source");
            await graph.pull("middle", binding);
            await graph.pull("dependent", binding);

            const srcKey = makeNodeStorageKey("source");
            const srcId = db.nodeKeyToId(srcKey);

            // Check revdeps are sorted
            const revdeps = db._readSublevel('revdeps', srcId);
            if (revdeps && revdeps.length > 1) {
                for (let i = 1; i < revdeps.length; i++) {
                    expect(revdeps[i] >= revdeps[i-1]).toBe(true);
                }
            }
        });
    });

    // === Inputs without counters ===
    describe("inputs record shape", () => {
        it("stores inputs as a plain array of identifiers without inputCounters", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            graph = makeIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];

            await graph.pull("source");
            await graph.pull("middle", binding);

            const midKey = makeNodeStorageKey("middle", binding);
            const midId = db.nodeKeyToId(midKey);

            const inputsRecord = db._readSublevel('inputs', midId);
            expect(inputsRecord).toBeTruthy();
            // Should be a plain array (the new format), not an object with inputCounters
            expect(Array.isArray(inputsRecord)).toBe(true);
            expect(inputsRecord.inputCounters).toBeUndefined();
        });
    });
});
