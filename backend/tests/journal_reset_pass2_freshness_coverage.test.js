/**
 * Reset Pass 2 target-validation freshness-coverage pin.
 *
 * `incremental-graph-journal-reset.md` Pass 2 requires a target certificate
 * exactly when replay at the post-barrier cut does not already yield
 * `TargetValid(K)` with the causal coverage the target freshness requires: a
 * target-fresh node whose edges already match must still be re-validated when
 * its selected certificate does not cover its occurrence's value-scoped
 * invalidations. This pins the production planner `planTargetValidations` on
 * both sides of that branch, which previously had no direct regression.
 */

const {
    nodeKeyToCanonicalString,
    parseJournalRecordId,
} = require("../src/generators/incremental_graph/journal");
const { planTargetValidations } = require("../src/generators/incremental_graph/journal_reset/pass2");

function must(value) {
    if (value instanceof Error) {
        throw new Error("fixture is invalid: " + value.message);
    }
    return value;
}

function nodeOf(id) {
    return { head: "event", args: [{ id }] };
}

function keyOf(id) {
    return nodeKeyToCanonicalString(nodeOf(id));
}

function idOf(text) {
    return must(parseJournalRecordId(text));
}

const LEAF = keyOf(1);
const PARENT = keyOf(2);
const LEAF_VALUE = idOf("aaaaaaaaa:1");
const PARENT_VALUE = idOf("aaaaaaaaa:2");

function targetOccurrence({ fresh }) {
    return {
        nodeKeyString: PARENT,
        nodeKey: nodeOf(2),
        valueId: PARENT_VALUE,
        nodeIdentifier: "2-abcdefghi",
        payload: { type: "entry_description", description: "x" },
        createdAt: "2020-01-01T00:00:00.000Z",
        modifiedAt: "2020-01-02T00:00:00.000Z",
        validInputs: new Set([LEAF]),
        fresh,
    };
}

function postBarrierWith({ covers }) {
    return {
        freshness: new Map([
            [
                PARENT,
                {
                    validInputs: new Set([LEAF]),
                    certificate: { coversValueInvalidations: covers },
                },
            ],
        ]),
    };
}

function plan(fresh, covers) {
    const outcome = planTargetValidations({
        postBarrier: postBarrierWith({ covers }),
        targetOccurrences: [targetOccurrence({ fresh })],
        resetValueIdOf: (nodeKeyString) => {
            if (nodeKeyString === LEAF) {
                return LEAF_VALUE;
            }
            if (nodeKeyString === PARENT) {
                return PARENT_VALUE;
            }
            return undefined;
        },
        nodeKeyOf: (nodeKeyString) => {
            if (nodeKeyString === LEAF) {
                return nodeOf(1);
            }
            if (nodeKeyString === PARENT) {
                return nodeOf(2);
            }
            return undefined;
        },
        currentInputKeysOfNode: (nodeKeyString) => (nodeKeyString === PARENT ? [LEAF] : []),
    });
    if ("error" in outcome) {
        throw new Error("planTargetValidations failed: " + outcome.error.message);
    }
    return outcome.requests;
}

describe("reset Pass 2 target-validation freshness coverage", () => {
    test("target-fresh node with matching edges but a non-covering certificate is re-validated", () => {
        const requests = plan(true, false);
        expect(requests).toHaveLength(1);
        expect(requests[0].node).toEqual(nodeOf(2));
        expect(requests[0].basis).toHaveLength(1);
    });

    test("target-fresh node with matching edges and a covering certificate needs no validation", () => {
        expect(plan(true, true)).toHaveLength(0);
    });

    test("target-stale node with matching edges needs no validation", () => {
        expect(plan(false, false)).toHaveLength(0);
    });
});
