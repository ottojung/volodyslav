/**
 * The pull fast path's precondition, asserted over the whole replica rather
 * than over one node.
 *
 * `readUpToDateCachedValue` in `src/generators/incremental_graph/pull.js` serves
 * an `up-to-date` node its stored value without consulting any validity state.
 * That read is sound exactly when the replica satisfies the clean-node validity
 * invariant of `docs/specs/incremental-graph-flag-based-inverse-validity.md`:
 * for every materialized `N` and every `D` in `inputEdges(N)`, an `up-to-date`
 * `N` has a stored value, every `D` is materialized and itself `up-to-date`, and
 * `N` is a member of `valid[D]`.
 *
 * The invariant is a property of the replica, not of a node, so this file
 * checks it over the entire materialized set and never over a named node in
 * isolation. A scenario's operations are not checked one at a time: in the
 * supersession scenario the anchor pull, the source pull and the invalidation
 * run before the first check, and in the repeated-supersession scenario both
 * dependents are pulled before the first check. A single scenario can leave one
 * particular dependent in a legal state while another dependent
 * somewhere else in the same replica is up-to-date without a proof; only the
 * whole-replica form of the assertion sees that.
 */

/* eslint jest/expect-expect: ["error", { "assertFunctionNames": ["expect", "expectUpToDateNodesProveEveryInput"] }] */

const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const {
    nodeIdentifierToString,
    nodeIdentifierFromString,
    deriveInputEdges,
} = require("../src/generators/incremental_graph/database");
const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");
const { numberComputedValue } = require("./computed_value_fixture");

/**
 * @typedef {import('../src/generators/incremental_graph').IncrementalGraph} IncrementalGraph
 * @typedef {import('../src/generators/incremental_graph/database').RootDatabase} RootDatabase
 */

/**
 * Build the replica-state capabilities every test in this file uses.
 * @returns {*}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return capabilities;
}

/**
 * Every identifier with a stored value, which is what the replica calls a
 * materialized node.
 * @param {RootDatabase} db
 * @returns {Promise<Array<string>>}
 */
async function listMaterializedIdentifierStrings(db) {
    const identifiers = [];
    for await (const identifier of db.getSchemaStorage().values.keys()) {
        identifiers.push(nodeIdentifierToString(identifier));
    }
    return identifiers.sort();
}

/**
 * Assert the clean-node validity invariant over the whole replica: no
 * materialized `up-to-date` node is missing a stored value, an `up-to-date`
 * input, or its membership in the input's `valid` set.
 *
 * This is the precondition `readUpToDateCachedValue` relies on and does not
 * itself check, so it is asserted here for every node at once after every
 * operation.
 *
 * @param {RootDatabase} db
 * @param {IncrementalGraph} graph
 * @param {string} step - Where the replica is, for the failure message.
 * @returns {Promise<void>}
 */
async function expectUpToDateNodesProveEveryInput(db, graph, step) {
    const storage = db.getSchemaStorage();
    const lookup = db.getActiveIdentifierLookup();
    const materialized = await listMaterializedIdentifierStrings(db);

    /** @type {Map<string, Array<string>>} */
    const inputEdgesByIdentifierString = new Map();
    /** @type {Map<string, string | undefined>} */
    const freshnessByIdentifierString = new Map();

    for (const identifierString of materialized) {
        const identifier = nodeIdentifierFromString(identifierString);
        if (!lookup.idToKey.has(identifierString)) {
            throw new Error(`${step}: no identifier lookup entry for materialized ${identifierString}`);
        }
        const edges = deriveInputEdges(graph.graphScheme, lookup, identifier);
        inputEdgesByIdentifierString.set(identifierString, edges.map(nodeIdentifierToString));
        freshnessByIdentifierString.set(
            identifierString,
            await storage.freshness.get(identifier)
        );
    }

    for (const identifierString of materialized) {
        if (freshnessByIdentifierString.get(identifierString) !== "up-to-date") {
            continue;
        }
        const identifier = nodeIdentifierFromString(identifierString);
        const storedValue = await storage.values.get(identifier);
        if (storedValue === undefined) {
            throw new Error(`${step}: up-to-date ${identifierString} has no stored value for the fast path to serve`);
        }
        for (const inputString of inputEdgesByIdentifierString.get(identifierString) ?? []) {
            if (!materialized.includes(inputString)) {
                throw new Error(`${step}: up-to-date ${identifierString} has unmaterialized input ${inputString}`);
            }
            if (freshnessByIdentifierString.get(inputString) !== "up-to-date") {
                throw new Error(`${step}: up-to-date ${identifierString} has potentially-outdated input ${inputString}`);
            }
            const dependents = await storage.valid.get(nodeIdentifierFromString(inputString)) ?? [];
            if (!dependents.some((id) => nodeIdentifierToString(id) === identifierString)) {
                throw new Error(`${step}: up-to-date ${identifierString} is absent from valid[${inputString}], so the fast path would serve a value no proof stands behind`);
            }
        }
    }
}

describe("the pull fast path's precondition over the whole replica", () => {
    /** @type {RootDatabase} */
    let db;

    afterEach(async () => {
        if (db !== undefined) {
            await db.close();
            db = undefined;
        }
    });

    /**
     * @param {Array<*>} nodeDefs
     * @returns {Promise<IncrementalGraph>}
     */
    async function buildGraph(nodeDefs) {
        const capabilities = getTestCapabilities();
        db = await getRootDatabase(capabilities);
        return await createIncrementalGraph(capabilities, db, nodeDefs);
    }

    test("holds across a diamond of pulls", async () => {
        const graph = await buildGraph([
            {
                output: "root",
                inputs: [],
                computor: async () => numberComputedValue(1),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "left",
                inputs: ["root"],
                computor: async ([root]) => numberComputedValue(root.value * 2),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "right",
                inputs: ["root"],
                computor: async ([root]) => numberComputedValue(root.value * 3),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "join",
                inputs: ["left", "right"],
                computor: async ([left, right]) => numberComputedValue(left.value + right.value),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        for (const node of ["root", "left", "right", "join", "join", "left"]) {
            await graph.pull(node);
            await expectUpToDateNodesProveEveryInput(db, graph, `after pulling ${node}`);
        }
    });

    test("holds across repeated invalidation and re-pull rounds", async () => {
        let counter = 0;
        const graph = await buildGraph([
            {
                output: "source",
                inputs: [],
                computor: async () => {
                    counter += 1;
                    return numberComputedValue(counter);
                },
                isDeterministic: false,
                hasSideEffects: false,
            },
            {
                output: "middle",
                inputs: ["source"],
                computor: async ([source]) => numberComputedValue(source.value + 1),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "leaf",
                inputs: ["middle"],
                computor: async ([middle]) => numberComputedValue(middle.value + 1),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await graph.pull("leaf");
        await expectUpToDateNodesProveEveryInput(db, graph, "after the first pull of the chain");

        for (let round = 0; round < 3; round++) {
            await graph.invalidate("source");
            await expectUpToDateNodesProveEveryInput(db, graph, `round ${round}: after invalidating source`);
            await graph.pull("leaf");
            await expectUpToDateNodesProveEveryInput(db, graph, `round ${round}: after re-pulling the chain`);
        }
    });

    test("holds after concurrent pulls of dependents sharing one dependency", async () => {
        /** @type {{ arrived: number, gate: Promise<void>, open: () => void } | undefined} */
        let rendezvous;

        const sharedComputor = async ([source]) => {
            const current = rendezvous;
            if (current === undefined) {
                return numberComputedValue(source.value + 1);
            }
            current.arrived += 1;
            if (current.arrived === 2) {
                current.open();
            }
            await current.gate;
            return numberComputedValue(source.value + 1);
        };

        /**
         * @returns {{ arrived: number, gate: Promise<void>, open: () => void }}
         */
        const makeRendezvous = () => {
            /** @type {() => void} */
            let open = () => undefined;
            const gate = new Promise((resolve) => { open = resolve; });
            return { arrived: 0, gate, open };
        };

        const graph = await buildGraph([
            {
                output: "source",
                inputs: [],
                computor: async () => numberComputedValue(1),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "left",
                inputs: ["source"],
                computor: sharedComputor,
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "right",
                inputs: ["source"],
                computor: sharedComputor,
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "leaf",
                inputs: ["left", "right"],
                computor: async ([left, right]) => numberComputedValue(left.value + right.value),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        rendezvous = makeRendezvous();
        await Promise.all([graph.pull("left"), graph.pull("right")]);
        await expectUpToDateNodesProveEveryInput(db, graph, "after concurrent pulls of left and right");

        await graph.pull("leaf");
        await expectUpToDateNodesProveEveryInput(db, graph, "after pulling the join of the concurrent pair");

        await graph.invalidate("source");
        await expectUpToDateNodesProveEveryInput(db, graph, "after invalidating the shared dependency");

        rendezvous = makeRendezvous();
        await Promise.all([graph.pull("left"), graph.pull("right")]);
        await expectUpToDateNodesProveEveryInput(db, graph, "after concurrent re-pulls of left and right");
    }, 30000);

    test("holds when one publication supersedes an occurrence a concurrent dependent validated against", async () => {
        // The dependency republishes a different value occurrence on every
        // materialization, so a dependent which validated against a
        // superseded occurrence is observably wrong while claiming to be up to
        // date. The assertion below is over the whole replica, so a dependent
        // that the superseding publication never named is still caught.
        let occurrences = 0;
        const nextOccurrence = () => {
            occurrences += 1;
            return numberComputedValue(1000 * occurrences);
        };

        /** @type {() => void} */
        let markBlocked = () => undefined;
        const blocked = new Promise((resolve) => { markBlocked = resolve; });
        /** @type {() => void} */
        let releaseBlocked = () => undefined;
        const released = new Promise((resolve) => { releaseBlocked = resolve; });

        const graph = await buildGraph([
            {
                output: "anchor",
                inputs: [],
                computor: async () => numberComputedValue(7),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "source",
                inputs: ["anchor"],
                computor: async () => nextOccurrence(),
                isDeterministic: false,
                hasSideEffects: false,
            },
            {
                output: "blocked",
                inputs: ["source"],
                computor: async ([source]) => {
                    markBlocked();
                    await released;
                    return numberComputedValue(source.value);
                },
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "racer",
                inputs: ["source"],
                computor: async ([source]) => numberComputedValue(source.value),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "spectator",
                inputs: ["racer"],
                computor: async ([racer]) => numberComputedValue(racer.value),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await graph.pull("anchor");
        await graph.pull("source");
        await graph.invalidate("source");
        await expectUpToDateNodesProveEveryInput(db, graph, "after invalidating the republished dependency");

        // The first operation republishes the dependency and blocks inside the
        // dependent's computor; the second publishes a later occurrence of the
        // same dependency and validates its own dependent against it. The first
        // publication then supersedes that later occurrence.
        const superseding = graph.pull("blocked");
        await blocked;
        await graph.pull("racer");
        await expectUpToDateNodesProveEveryInput(db, graph, "after the racer published against the later occurrence");

        releaseBlocked();
        await superseding;
        await expectUpToDateNodesProveEveryInput(db, graph, "after the superseding publication committed");

        await graph.pull("spectator");
        await expectUpToDateNodesProveEveryInput(db, graph, "after pulling the spectator of the superseded dependent");
    }, 30000);

    test("holds across repeated supersession rounds of the same shared dependency", async () => {
        let occurrences = 0;
        const graph = await buildGraph([
            {
                output: "anchor",
                inputs: [],
                computor: async () => numberComputedValue(1),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "source",
                inputs: ["anchor"],
                computor: async () => {
                    occurrences += 1;
                    return numberComputedValue(occurrences);
                },
                isDeterministic: false,
                hasSideEffects: false,
            },
            {
                output: "left",
                inputs: ["source"],
                computor: async ([source]) => numberComputedValue(source.value * 10),
                isDeterministic: true,
                hasSideEffects: false,
            },
            {
                output: "right",
                inputs: ["source"],
                computor: async ([source]) => numberComputedValue(source.value * 100),
                isDeterministic: true,
                hasSideEffects: false,
            },
        ]);

        await graph.pull("left");
        await graph.pull("right");
        await expectUpToDateNodesProveEveryInput(db, graph, "after the first materialization of both dependents");

        for (let round = 0; round < 3; round++) {
            await graph.invalidate("source");
            await expectUpToDateNodesProveEveryInput(db, graph, `round ${round}: after invalidating the dependency`);
            await graph.pull("left");
            await expectUpToDateNodesProveEveryInput(db, graph, `round ${round}: after re-pulling left`);
            await graph.pull("right");
            await expectUpToDateNodesProveEveryInput(db, graph, `round ${round}: after re-pulling right`);
        }
    });
});
