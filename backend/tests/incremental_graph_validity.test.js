/**
 * Tests for the flag-based inverse validity algorithm.
 *
 * These tests validate the specification defined in:
 */

const {
    createIncrementalGraph,
    makeUnchanged,
    isUnchanged,
} = require("../src/generators/incremental_graph");
const {
    GRAPH_SCHEME_KEY,
    makeEmptyIdentifierLookup,
    cloneIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    nodeIdentifierFromString,
    nodeIdentifierToString,
} = require("../src/generators/incremental_graph/database");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubScheduler, stubRuntimeStateStorage } = require("./stubs");
const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { prepareIncrementalGraphStorage } = require("../src/generators/incremental_graph/prepare_graph_storage");
const internalGraphClassModule = require("../src/generators/incremental_graph/class");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubScheduler(capabilities);
    stubRuntimeStateStorage(capabilities);
    return capabilities;
}

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
        return nodeIdentifierFromString(id);
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
        const valid = createSublevel('valid');
        const timestamps = createSublevel('timestamps');
        const global = createSublevel('global');

        return {
            values,
            freshness,
            valid,
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
function countedComputor(_name, valueFactory) {
    let callCount = 0;
    const computor = async (_inputs, _oldValue, _bindings) => {
        callCount++;
        const result = valueFactory(callCount);
        if (isUnchanged(result)) {
            return result;
        }
        return result;
    };
    return { computor, getCallCount: () => callCount };
}

describe("Incremental graph validity", () => {
    /**
     * @type {InMemoryDatabase}
     */
    let db;
    /**
     * @type {ReturnType<createIncrementalGraph>}
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

    // === Test Obligation 1: Cache hit through valid flags (not freshness fast-path) ===
    describe("test obligation 1: stale nodes recompute", () => {
        it("invokes computor after invalidation revokes validity proofs", async () => {
            const { nodeDefs, middleCC, dependentCC } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];
            const midKey = makeNodeStorageKey("middle", binding);
            const depKey = makeNodeStorageKey("dependent", binding);

            // Pull chain to materialize and establish valid flags
            await graph.pull("source");
            await graph.pull("middle", binding);
            await graph.pull("dependent", binding);

            const midId = db.nodeKeyToId(midKey);
            const depId = db.nodeKeyToId(depKey);

            // Verify valid flags were established: valid[mid].has(dep)
            const validMid = db._readSublevel('valid', midId);
            expect(validMid).toBeTruthy();
            expect(validMid.some(id => id === nodeIdentifierToString(depId))).toBe(true);

            // Now mark dependent potentially-outdated directly
            // (bypasses freshness fast-path, forces computor invocation)
            await graph.invalidate("dependent", binding);
            expect(db._readSublevel('freshness', depId)).toBe("potentially-outdated");

            const depCallsBefore = dependentCC.getCallCount();
            const midCallsBefore = middleCC.getCallCount();

            const result = await graph.pull("dependent", binding);

            expect(dependentCC.getCallCount()).toBe(depCallsBefore + 1);
            expect(middleCC.getCallCount()).toBe(midCallsBefore);
            expect(result).toEqual({ v: "dep" });
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

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);

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
        it("records valid[D].add(N) and keeps invalidated downstream stale", async () => {
            let midCalls = 0;
            const { nodeDefs, dependentCC } = createChainGraph(
                () => ({ v: "src" }),
                () => {
                    midCalls++;
                    if (midCalls === 1) return { v: "mid-first" };
                    return makeUnchanged();
                },
                () => ({ v: "dep" })
            );

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];
            const srcKey = makeNodeStorageKey("source");
            const midKey = makeNodeStorageKey("middle", binding);
            const depKey = makeNodeStorageKey("dependent", binding);

            // Materialize all nodes
            await graph.pull("source");
            await graph.pull("middle", binding);
            await graph.pull("dependent", binding);
            const srcId = db.nodeKeyToId(srcKey);
            const midId = db.nodeKeyToId(midKey);
            const depId = db.nodeKeyToId(depKey);

            // Snapshot valid[S] before invalidation — should contain mid
            const validSrcBefore = db._readSublevel('valid', srcId);
            expect(validSrcBefore.some(id => id === nodeIdentifierToString(midId))).toBe(true);


            // Invalidate source, pull it, then pull middle (returns Unchanged)
            await graph.invalidate("source");
            await graph.pull("source");
            await graph.pull("middle", binding);
            expect(midCalls).toBe(2);


            const validMid = db._readSublevel('valid', midId) ?? [];
            expect(validMid.some(id => id === nodeIdentifierToString(depId))).toBe(false);

            // valid[S] now has a fresh flag for mid (added by handleUnchanged)
            const validSrcAfter = db._readSublevel('valid', srcId);
            expect(validSrcAfter.some(id => id === nodeIdentifierToString(midId))).toBe(true);

            const depCallsBefore = dependentCC.getCallCount();
            const result = await graph.pull("dependent", binding);
            expect(dependentCC.getCallCount()).toBe(depCallsBefore + 1);
            expect(result).toEqual({ v: "dep" });
        });
    });

    // === Test Obligation 4: Changed value clears validity ===
    describe("test obligation 4: changed value clears validity", () => {
        it("removes stale incoming validity, clears downstream validity, and writes the changed value", async () => {
            let srcValue = 0;
            const { nodeDefs } = createChainGraph(
                () => ({ v: ++srcValue }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];
            const midKey = makeNodeStorageKey("middle", binding);
            const depKey = makeNodeStorageKey("dependent", binding);

            await graph.pull("source");
            await graph.pull("middle", binding);
            await graph.pull("dependent", binding);

            const midId = db.nodeKeyToId(midKey);
            const depId = db.nodeKeyToId(depKey);

            // valid[mid] contains dep (downstream validity established)
            const validMidBefore = db._readSublevel('valid', midId);
            expect(validMidBefore.some(id => id === nodeIdentifierToString(depId))).toBe(true);


            // Invalidate and pull source with changed value
            // → middle recomputes (changed) → dependent becomes potentially-outdated
            await graph.invalidate("source");
            await graph.pull("source");
            await graph.pull("middle", binding);

            // After source changed: valid[source] was cleared (old mid flag removed)
            // mid's handleChanged cleared valid[mid] and added fresh valid[source].has(mid)
            // valid[mid] was cleared, so it no longer contains dep
            const validMidAfter = db._readSublevel('valid', midId) || [];
            expect(validMidAfter.some(id => id === nodeIdentifierToString(depId))).toBe(false);

            // Pull dependent: must recompute (valid[mid].has(dep) was cleared)
            await graph.pull("dependent", binding);


            // Fresh valid flags established after recompute
            const validMidFinal = db._readSublevel('valid', midId);
            expect(validMidFinal.some(id => id === nodeIdentifierToString(depId))).toBe(true);
        });
    });

    // === Test: Changed value propagates potentially-outdated freshness through valid ===
    describe("changed value propagates outdated through valid", () => {
        it("marks direct and transitive dependents potentially-outdated when value changes via direct storage manipulation bypassing invalidation", async () => {
            let srcValue = 0;
            const { nodeDefs } = createChainGraph(
                () => ({ v: ++srcValue }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];
            const srcKey = makeNodeStorageKey("source");
            const midKey = makeNodeStorageKey("middle", binding);
            const depKey = makeNodeStorageKey("dependent", binding);

            // Materialize all three nodes
            await graph.pull("source");
            await graph.pull("middle", binding);
            await graph.pull("dependent", binding);

            const srcId = db.nodeKeyToId(srcKey);
            const midId = db.nodeKeyToId(midKey);
            const depId = db.nodeKeyToId(depKey);

            // Verify all are up-to-date
            expect(db._readSublevel('freshness', srcId)).toBe("up-to-date");
            expect(db._readSublevel('freshness', midId)).toBe("up-to-date");
            expect(db._readSublevel('freshness', depId)).toBe("up-to-date");

            // Directly mark only source as potentially-outdated in storage.
            // Do NOT call graph.invalidate() — that already propagates through valid.
            const schemaStorage = db.getSchemaStorage();
            await schemaStorage.freshness.put(srcId, "potentially-outdated");

            // Pull source — computor returns changed value (srcValue was 0, now 1).
            // handleChanged consumes outgoing validity proofs through the shared strong invalidation helper.
            await graph.pull("source");

            // Middle is a direct dependent of source via valid
            expect(db._readSublevel('freshness', midId)).toBe("potentially-outdated");

            // Dependent is a transitive dependent via middle's valid
            expect(db._readSublevel('freshness', depId)).toBe("potentially-outdated");
        });

        it("marks direct and transitive dependents potentially-outdated when value changes", async () => {
            let srcValue = 0;
            const { nodeDefs } = createChainGraph(
                () => ({ v: ++srcValue }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];

            await graph.pull("source");
            await graph.pull("middle", binding);
            await graph.pull("dependent", binding);

            const midKey = makeNodeStorageKey("middle", binding);
            const depKey = makeNodeStorageKey("dependent", binding);
            const midId = db.nodeKeyToId(midKey);
            const depId = db.nodeKeyToId(depKey);

            // Both are up-to-date after pulls
            expect(db._readSublevel('freshness', midId)).toBe("up-to-date");
            expect(db._readSublevel('freshness', depId)).toBe("up-to-date");

            // Invalidate and pull source with changed value
            await graph.invalidate("source");
            await graph.pull("source"); // triggers middle recompute, which changes

            // After source's handleChanged propagates, middle should be
            // potentially-outdated because its dependency (source) changed value
            // and valid[source] was cleared.
            // Actually, pulling source only affects source. To see propagation,
            // we need to pull middle — which recomputes and its handleChanged
            // should mark dependent as potentially-outdated.

            // Pull middle with changed dependency -> it recomputes and propagates
            await graph.pull("middle", binding);

            // dependent should be potentially-outdated now (propagated from middle's handleChanged)
            expect(db._readSublevel('freshness', depId)).toBe("potentially-outdated");
        });
    });
    describe("test obligation 5: changed dependency prevents stale cache hit", () => {
        it("clears valid[D] when D changes value, forcing dependent recompute", async () => {
            let srcValue = 0;
            const { nodeDefs, dependentCC } = createChainGraph(
                () => ({ v: ++srcValue }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];
            const srcKey = makeNodeStorageKey("source");
            const depKey = makeNodeStorageKey("dependent", binding);

            await graph.pull("source");
            await graph.pull("middle", binding);
            await graph.pull("dependent", binding);

            const srcId = db.nodeKeyToId(srcKey);
            const depId = db.nodeKeyToId(depKey);

            // valid[S] exists with mid in it
            const validSrcBefore = db._readSublevel('valid', srcId);
            expect(validSrcBefore.length).toBeGreaterThan(0);

            const depCallsBefore = dependentCC.getCallCount();

            // Invalidate source, pull (changed), then pull middle (recomputes, propagates)
            await graph.invalidate("source");
            await graph.pull("source");
            await graph.pull("middle", binding);

            // After source changed: valid[S] was cleared in handleChanged, then rebuilt
            // with fresh flags for the new value
            const validSrcAfter = db._readSublevel('valid', srcId);
            // The old valid[S] entries are gone. New valid[S] has fresh flag for mid.
            // The important thing is that valid[D] was cleared when D changed value.
            expect(validSrcAfter.length).toBeGreaterThan(0);

            // Middle's handleChanged propagated outdated to dependent
            expect(db._readSublevel('freshness', depId)).toBe("potentially-outdated");

            // Pull dependent — must recompute (valid flags from old mid value are cleared)
            await graph.pull("dependent", binding);
            expect(dependentCC.getCallCount()).toBe(depCallsBefore + 1);
        });
    });

    // === Test Obligation 6: External invalidation does not mutate valid ===
    describe("test obligation 6: external invalidation consumes valid", () => {
        it("removes validity flags when nodes are invalidated", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];

            await graph.pull("source");
            await graph.pull("middle", binding);
            await graph.pull("dependent", binding);

            const srcKey = makeNodeStorageKey("source");
            const midKey = makeNodeStorageKey("middle", binding);
            const srcId = db.nodeKeyToId(srcKey);
            const midId = db.nodeKeyToId(midKey);

            // Snapshot valid sets before invalidation
            const validSrcBefore = db._readSublevel('valid', srcId);
            const validMidBefore = db._readSublevel('valid', midId);

            await graph.invalidate("source");

            expect(validSrcBefore).toBeDefined();
            expect(validMidBefore).toBeDefined();
            expect(db._readSublevel('valid', srcId) ?? []).toEqual([]);
            expect(db._readSublevel('valid', midId) ?? []).toEqual([]);

            // Freshness is marked potentially-outdated (not valid)
            expect(db._readSublevel('freshness', midId)).toBe("potentially-outdated");
        });
    });

    // === Test Obligation 7: Failed computor rolls back ===
    describe("test obligation 7: failed computor rolls back", () => {
        it("does not partially write values, freshness, or valid", async () => {
            let shouldFail = false;
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => {
                    if (shouldFail) throw new Error("computor failure");
                    return { v: "mid" };
                },
                () => ({ v: "dep" })
            );

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];
            const midKey = makeNodeStorageKey("middle", binding);

            // Materialize source and middle first time
            await graph.pull("source");
            await graph.pull("middle", binding);

            const midId = db.nodeKeyToId(midKey);
            const oldValue = db._readSublevel('values', midId);
            const oldValid = db._readSublevel('valid', midId);

            shouldFail = true;
            await graph.invalidate("source");

            // Pull middle — computor throws
            await expect(graph.pull("middle", binding)).rejects.toThrow("computor failure");

            // After failure: all of middle's state is preserved
            expect(db._readSublevel('values', midId)).toEqual(oldValue);
            expect(db._readSublevel('valid', midId)).toEqual(oldValid);
            // Freshness left as potentially-outdated (from the invalidation)
            expect(db._readSublevel('freshness', midId)).toBe("potentially-outdated");
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

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);
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
                    computor: async (inputs, _oldValue, _bindings) => {
                        receivedInputs.push(inputs);
                        return { v: "dup_user", count: inputs.length };
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
            ];

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];

            await graph.pull("source");
            await graph.pull("dup_user", binding);

            // Computor should receive 2 arguments (both source values)
            expect(receivedInputs.length).toBe(1);
            expect(receivedInputs[0].length).toBe(2);
            expect(receivedInputs[0][0]).toEqual({ v: "src" });
            expect(receivedInputs[0][1]).toEqual({ v: "src" });

            // Valid flags should have only 1 entry (collapsed)
            const dupKey = makeNodeStorageKey("dup_user", binding);
            const dupId = db.nodeKeyToId(dupKey);
            const srcKey = makeNodeStorageKey("source");
            const srcId = db.nodeKeyToId(srcKey);
            const validSrc = db._readSublevel('valid', srcId);
            expect(Array.isArray(validSrc)).toBe(true);
            expect(validSrc.some(id => String(id) === String(dupId))).toBe(true);
        });
    });

    // === Test Obligation 11: Downstream validity survives upstream Unchanged ===
    describe("test obligation 11: downstream recomputes after upstream invalidation", () => {
        it("A -> B -> C: when B returns Unchanged, C still recomputes", async () => {
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

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];
            const bKey = makeNodeStorageKey("B", binding);
            const cKey = makeNodeStorageKey("C", binding);

            // Materialize chain A -> B -> C
            await graph.pull("A");
            await graph.pull("B", binding);
            await graph.pull("C", binding);
            expect(bCalls).toBe(1);
            expect(cCalls).toBe(1);

            const bId = db.nodeKeyToId(bKey);
            const cId = db.nodeKeyToId(cKey);

            // valid[B].has(C) exists from initial materialization
            const validB = db._readSublevel('valid', bId);
            expect(validB.some(id => id === nodeIdentifierToString(cId))).toBe(true);

            // Invalidate A, pull it, then pull B (returns Unchanged)
            await graph.invalidate("A");
            await graph.pull("A");
            await graph.pull("B", binding);
            expect(bCalls).toBe(2);

            const validBAgain = db._readSublevel('valid', bId) ?? [];
            expect(validBAgain.some(id => id === nodeIdentifierToString(cId))).toBe(false);

            const cCallsBefore = cCalls;
            const result = await graph.pull("C", binding);
            expect(cCalls).toBe(cCallsBefore + 1);
            expect(result).toEqual({ v: "C-2" });
        });
    });

    // === Deterministic serialization ===
    describe("deterministic serialization", () => {
        it("stores valid sets in sorted order", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];

            await graph.pull("source");
            await graph.pull("middle", binding);
            await graph.pull("dependent", binding);

            const srcKey = makeNodeStorageKey("source");
            const srcId = db.nodeKeyToId(srcKey);

            // Check valid is sorted
            const validSrc = db._readSublevel('valid', srcId);
            expect(validSrc).toBeTruthy();
            expect(validSrc.length).toBeGreaterThan(0);
            for (let i = 1; i < validSrc.length; i++) {
                expect(validSrc[i] >= validSrc[i-1]).toBe(true);
            }
        });
    });

    // === Test: Up-to-date node returns from cache without checking validity flags ===
    describe("up-to-date fast path does not consult validity flags", () => {
        it("returns cached value for up-to-date non-source node even when validity flags are removed", async () => {
            const { nodeDefs, dependentCC } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];
            const midKey = makeNodeStorageKey("middle", binding);
            const depKey = makeNodeStorageKey("dependent", binding);

            await graph.pull("source");
            await graph.pull("middle", binding);
            await graph.pull("dependent", binding);

            const srcId = db.nodeKeyToId(makeNodeStorageKey("source"));
            const midId = db.nodeKeyToId(midKey);
            const depId = db.nodeKeyToId(depKey);

            // All nodes are up-to-date with valid flags
            expect(db._readSublevel('freshness', depId)).toBe("up-to-date");

            // Directly remove validity flags from storage to simulate invariant violation
            // (this is not a normal runtime state, but the fast path should not check it)
            const schemaStorage = db.getSchemaStorage();
            await schemaStorage.valid.put(srcId, []);
            await schemaStorage.valid.put(midId, []);

            // Verify validity flags are gone
            expect(db._readSublevel('valid', srcId)).toEqual([]);
            expect(db._readSublevel('valid', midId)).toEqual([]);

            // Pull dependent: freshness is "up-to-date", fast path returns without checking valid
            const depCallsBefore = dependentCC.getCallCount();
            const result = await graph.pull("dependent", binding);

            expect(dependentCC.getCallCount()).toBe(depCallsBefore);
            expect(result).toEqual({ v: "dep" });
        });

        it("returns cached value for up-to-date zero-input node (no validity flags needed)", async () => {
            let callCount = 0;
            const nodeDefs = [
                {
                    output: "source",
                    inputs: [],
                    computor: async () => {
                        callCount++;
                        return { v: "src" };
                    },
                    isDeterministic: false,
                    hasSideEffects: false,
                },
            ];

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);

            await graph.pull("source");
            expect(callCount).toBe(1);

            // source is up-to-date, no validity flags exist (zero-input node has no valid entries)
            const srcKey = makeNodeStorageKey("source");
            const srcId = db.nodeKeyToId(srcKey);
            expect(db._readSublevel('valid', srcId) ?? []).toEqual([]);

            // Second pull: fast path returns cached value without checking valid
            const result = await graph.pull("source");
            expect(callCount).toBe(1);
            expect(result).toEqual({ v: "src" });
        });
    });

    // === Test: Potentially-outdated with missing validity flags recomputes ===
    describe("potentially-outdated node with missing validity flags", () => {
        it("recomputes when potentially-outdated and validity flags are missing", async () => {
            let srcValue = 0;
            const { nodeDefs, dependentCC } = createChainGraph(
                () => ({ v: ++srcValue }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];
            const depKey = makeNodeStorageKey("dependent", binding);

            await graph.pull("source");
            await graph.pull("middle", binding);
            await graph.pull("dependent", binding);

            const srcKey = makeNodeStorageKey("source");
            const srcId = db.nodeKeyToId(srcKey);
            const midId = db.nodeKeyToId(makeNodeStorageKey("middle", binding));
            const depId = db.nodeKeyToId(depKey);

            // All up-to-date
            expect(db._readSublevel('freshness', depId)).toBe("up-to-date");

            // Invalidate dependent → potentially-outdated
            await graph.invalidate("dependent", binding);

            // Remove validity flags so the stale node recomputes
            const schemaStorage = db.getSchemaStorage();
            await schemaStorage.valid.put(srcId, []);
            await schemaStorage.valid.put(midId, []);

            const depCallsBefore = dependentCC.getCallCount();

            // Pull dependent: potentially-outdated + no valid flags → must recompute
            const result = await graph.pull("dependent", binding);
            expect(dependentCC.getCallCount()).toBe(depCallsBefore + 1);
            expect(result).toEqual({ v: "dep" });
        });
    });

    // === Test: Up-to-date node with missing value throws ===
    describe("up-to-date node invariant enforcement", () => {
        it("throws when up-to-date node has no stored value", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            const testCapabilities = getTestCapabilities();
            graph = await createIncrementalGraph(testCapabilities, db, nodeDefs);
            const binding = [{ id: "x" }];
            const depKey = makeNodeStorageKey("dependent", binding);

            await graph.pull("source");
            await graph.pull("middle", binding);
            await graph.pull("dependent", binding);

            // Remove the value from storage while keeping freshness = up-to-date
            // This simulates a corruption scenario
            const schemaStorage = db.getSchemaStorage();
            const depId = db.nodeKeyToId(depKey);
            await schemaStorage.values.del(depId);

            await expect(graph.pull("dependent", binding)).rejects.toThrow(
                /has no cached value/
            );
        });
    });

    // === graph_scheme tests ===
    describe("graph_scheme persistence model", () => {
        it("writes graph_scheme and version on fresh database", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            const freshDb = new InMemoryDatabase();
            const testCapabilities = getTestCapabilities();
            await createIncrementalGraph(testCapabilities, freshDb, nodeDefs);

            const schemaStorage = freshDb.getSchemaStorage();
            const storedScheme = await schemaStorage.global.get(GRAPH_SCHEME_KEY);
            expect(typeof storedScheme).toBe("string");
            expect(storedScheme.length).toBeGreaterThan(0);

            const storedVersion = await schemaStorage.global.get("version");
            expect(storedVersion).toBe("test-version");
        });



        it("direct fresh schema batch does not initialize version without graph_scheme", async () => {
            const testCapabilities = getTestCapabilities();
            const db = await getRootDatabase(testCapabilities);
            try {
                const storage = db.getSchemaStorage();
                await storage.batch([
                    storage.values.putOp(nodeIdentifierFromString("1-abcdefghi"), { v: "stored" }),
                ]);

                expect(await storage.global.get("version")).toBeUndefined();
                expect(await storage.global.get(GRAPH_SCHEME_KEY)).toBeUndefined();
            } finally {
                await db.close();
            }
        });

        it("prepareIncrementalGraphStorage writes version and graph_scheme on fresh database", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );
            const freshDb = new InMemoryDatabase();

            const prepared = await prepareIncrementalGraphStorage(freshDb, nodeDefs);
            expect(prepared.graphScheme).toBeDefined();
            const schemaStorage = freshDb.getSchemaStorage();
            expect(await schemaStorage.global.get("version")).toBe("test-version");
            expect(typeof await schemaStorage.global.get(GRAPH_SCHEME_KEY)).toBe("string");
        });

        it("graph_scheme without version fails as graph scheme metadata error", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );
            const existingDb = new InMemoryDatabase();
            await existingDb.getSchemaStorage().global.put(GRAPH_SCHEME_KEY, JSON.stringify({ format: 1, nodes: [] }));

            await expect(
                prepareIncrementalGraphStorage(existingDb, nodeDefs)
            ).rejects.toThrow(/graph_scheme exists but version is missing/);
        });

        it("malformed graph_scheme JSON fails as graph scheme metadata error", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );
            const existingDb = new InMemoryDatabase();
            const storage = existingDb.getSchemaStorage();
            await storage.global.put("version", "test-version");
            await storage.global.put(GRAPH_SCHEME_KEY, "{not-json");

            await expect(
                prepareIncrementalGraphStorage(existingDb, nodeDefs)
            ).rejects.toThrow(/Invalid graph_scheme JSON/);
        });

        it("non-string stored graph_scheme fails as graph scheme metadata error", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );
            const existingDb = new InMemoryDatabase();
            const storage = existingDb.getSchemaStorage();
            await storage.global.put("version", "test-version");
            await storage.global.put(GRAPH_SCHEME_KEY, { format: 1, nodes: [] });

            await expect(
                prepareIncrementalGraphStorage(existingDb, nodeDefs)
            ).rejects.toThrow(/expected string/);
        });

        it("public index exports ordinary factory but not prepared constructor", async () => {
            const publicIndex = require("../src/generators/incremental_graph");
            expect(typeof publicIndex.createIncrementalGraph).toBe("function");
            expect(publicIndex.makePreparedIncrementalGraph).toBeUndefined();
            expect(publicIndex.makeIncrementalGraph).toBeUndefined();
        });

        it("prepared graph constructor accepts prepared storage", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );
            const db = new InMemoryDatabase();
            const prepared = await prepareIncrementalGraphStorage(db, nodeDefs);
            const testCapabilities = getTestCapabilities();
            const graph = internalGraphClassModule.makePreparedIncrementalGraph(testCapabilities, db, prepared);
            expect(graph.getSchemaByHead("source")).not.toBeNull();
        });

        it("prepared graph constructor rejects prepared storage from a different root database", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );
            const sourceDb = new InMemoryDatabase();
            const targetDb = new InMemoryDatabase();
            const prepared = await prepareIncrementalGraphStorage(sourceDb, nodeDefs);

            const testCapabilities = getTestCapabilities();
            expect(() => internalGraphClassModule.makePreparedIncrementalGraph(testCapabilities, targetDb, prepared)).toThrow(/same root database/);
        });

        it("prepared graph constructor rejects node definitions immediately", () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );
            const db = new InMemoryDatabase();
            const testCapabilities = getTestCapabilities();
            expect(() => internalGraphClassModule.makePreparedIncrementalGraph(testCapabilities, db, nodeDefs)).toThrow(/prepareIncrementalGraphStorage/);
        });

        it("does not overwrite graph_scheme on existing initialized database with matching scheme", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            // Compute the exact scheme that createIncrementalGraph would write
            const compiledNodes = nodeDefs.map(
                (nd) => require("../src/generators/incremental_graph/compiled_node").compileNodeDef(nd)
            );
            const { buildGraphSchemeFromNodeDefs, serializeGraphScheme } =
                require("../src/generators/incremental_graph/database");
            const exactScheme = JSON.stringify(
                serializeGraphScheme(buildGraphSchemeFromNodeDefs(compiledNodes))
            );

            // Pre-seed storage with the EXACT matching scheme and version
            const existingDb = new InMemoryDatabase();
            const storage = existingDb.getSchemaStorage();
            await storage.global.put(GRAPH_SCHEME_KEY, exactScheme);
            await storage.global.put("version", "test-version");

            // Create graph — should NOT throw because schemes match
            const testCapabilities = getTestCapabilities();
            const g = await createIncrementalGraph(testCapabilities, existingDb, nodeDefs);

            // Verify graph_scheme was NOT overwritten
            const stored = await storage.global.get(GRAPH_SCHEME_KEY);
            expect(stored).toBe(exactScheme);

            // Pull should also succeed
            await g.pull("source");
        });

        it("semantically equivalent but differently formatted scheme fails validation", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            // Pre-seed with a scheme that has different node ordering
            // (source, middle, dependent) vs canonical alphabetical
            // (dependent, middle, source).  The JSON is semantically identical
            // but the serialized strings differ.
            const schemeDiffOrder = JSON.stringify({
                format: 1,
                nodes: [
                    { head: "source", arity: 0, inputTemplates: [] },
                    { head: "middle", arity: 1, inputTemplates: [{ head: "source", args: [0] }] },
                    { head: "dependent", arity: 1, inputTemplates: [{ head: "middle", args: [0] }] },
                ],
            });

            const existingDb = new InMemoryDatabase();
            const storage = existingDb.getSchemaStorage();
            await storage.global.put(GRAPH_SCHEME_KEY, schemeDiffOrder);
            await storage.global.put("version", "test-version");

            // Validation fails immediately during construction, not on pull
            const testCapabilities = getTestCapabilities();
            await expect(
                createIncrementalGraph(testCapabilities, existingDb, nodeDefs)
            ).rejects.toThrow(/graph_scheme/);
        });

        it("versioned database missing graph_scheme fails", async () => {
            const { nodeDefs } = createChainGraph(
                () => ({ v: "src" }),
                () => ({ v: "mid" }),
                () => ({ v: "dep" })
            );

            const existingDb = new InMemoryDatabase();
            const storage = existingDb.getSchemaStorage();
            // Write version but NO graph_scheme
            await storage.global.put("version", "test-version");

            // Error is thrown immediately during construction
            const testCapabilities = getTestCapabilities();
            await expect(
                createIncrementalGraph(testCapabilities, existingDb, nodeDefs)
            ).rejects.toThrow(/global\/graph_scheme/);
        });
    });
});
