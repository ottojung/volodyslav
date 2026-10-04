/**
 * The order structural closure removal publishes its nodes in.
 *
 * `incremental-graph-journal-sync.md` §Structural closure requires the removals to
 * be published so that a node's removed inputs precede it, and requires the
 * publication to be a function of the retained journal rather than of traversal
 * order, which the ascending canonical tie-break provides.
 *
 * The walk maintains its ready set and its reverse dependent index incrementally,
 * so these fixtures pin the order it produces: a chain with one ready node per
 * round, a round in which several nodes become ready together, and a fan-in whose
 * dependent becomes ready only after every one of its inputs is emitted.
 */

const {
    HeadSelectionClass,
    makeAuthorityTime,
    makeJournalFrontierFromText,
    makeValueEvent,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const { planDependencyClosureRemoval } =
    require("../src/generators/incremental_graph/journal_sync");

const WRITER = "aaaaaaaaa";
const PAYLOAD = { type: "entry_description", description: "x" };
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";

/**
 * The canonical key of one numbered node of the fixture schema.
 * @param {number} id
 */
function keyOf(id) {
    return nodeKeyToCanonicalString({ head: "event", args: [{ id }] });
}

/**
 * One selected present head per node key, keyed in ascending canonical order.
 *
 * @param {ReadonlyArray<number>} ids
 * @returns {Map<string, import("../src/generators/incremental_graph/journal").HeadSelection>}
 */
function selectionsOf(ids) {
    const selections = new Map();
    for (const id of [...ids].sort((left, right) =>
        keyOf(left) < keyOf(right) ? -1 : 1
    )) {
        const node = { head: "event", args: [{ id }] };
        const winner = makeValueEvent(
            {
                id: WRITER + ":1",
                context: makeJournalFrontierFromText([]),
                authorityTime: makeAuthorityTime(1, "0"),
                node,
            },
            String(id) + "-abcdefghi",
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        );
        selections.set(nodeKeyToCanonicalString(node), new HeadSelectionClass(node, winner));
    }
    return selections;
}

/**
 * The fixture schema as a function over canonical keys, given each node's inputs.
 * @param {ReadonlyMap<number, ReadonlyArray<number>>} inputs
 */
function schemaOf(inputs) {
    return (nodeKeyString) => {
        for (const [id, nodeInputs] of inputs) {
            if (keyOf(id) === nodeKeyString) {
                return nodeInputs.map(keyOf);
            }
        }
        return [];
    };
}

/**
 * @param {import("../src/generators/incremental_graph/journal_sync").ClosureRemoval} removal
 */
function keysOf(removal) {
    return removal.nodes.map((node) => nodeKeyToCanonicalString(node));
}

describe("planDependencyClosureRemoval, the published order", () => {
    test("a chain seeded by one absent input is published cause before dependent", () => {
        const removal = planDependencyClosureRemoval({
            selections: selectionsOf([1, 2, 3]),
            currentInputKeysOfNode: schemaOf(new Map([
                [1, [9]],
                [2, [1]],
                [3, [2]],
            ])),
        });

        expect(keysOf(removal)).toEqual([keyOf(1), keyOf(2), keyOf(3)]);
    });

    test("nodes which become ready together are published in ascending canonical order", () => {
        const removal = planDependencyClosureRemoval({
            selections: selectionsOf([1, 2, 3, 4]),
            currentInputKeysOfNode: schemaOf(new Map([
                [1, [0]],
                [2, [0]],
                [3, [0]],
                [4, [1, 2, 3]],
            ])),
        });

        expect(keysOf(removal)).toEqual([keyOf(1), keyOf(2), keyOf(3), keyOf(4)]);
    });

    test("a fan-in waits for every one of its inputs before it is published", () => {
        const removal = planDependencyClosureRemoval({
            selections: selectionsOf([1, 2, 3, 4, 5]),
            currentInputKeysOfNode: schemaOf(new Map([
                [1, [0]],
                [2, [0]],
                [3, [0]],
                [4, [1, 3]],
                [5, [2, 4]],
            ])),
        });

        expect(keysOf(removal)).toEqual([
            keyOf(1),
            keyOf(2),
            keyOf(3),
            keyOf(4),
            keyOf(5),
        ]);
    });

    test("a node with no absent input in its closure is not removed", () => {
        const removal = planDependencyClosureRemoval({
            selections: selectionsOf([1, 2, 3]),
            currentInputKeysOfNode: schemaOf(new Map([
                [2, [1]],
                [3, [2]],
            ])),
        });

        expect(keysOf(removal)).toEqual([]);
    });
});
