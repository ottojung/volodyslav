/**
 * The gate on the `closedSpine` basis claim published in the comment at
 * `interleaving_space.js:1050-1060`.
 *
 * The comment says: five of the twelve fixture builders in that section are
 * built on `closedSpine`, and names all five. A number written in prose stays
 * true only while something can contradict it, so this suite pins both the
 * numerator and the denominator of that sentence to the module as committed and
 * fails when either moves.
 *
 * Every number here is re-derived by the instrument in
 * `interleaving_space_closed_spine_basis_check.js`, which drives every export of
 * the module and cross-checks the denominator against the module's own static
 * function definitions. Nothing in this file is read from a list the
 * instrument's enumeration depends on.
 */

const { measureAsCommitted } = require("./interleaving_space_closed_spine_basis_check");

/** The five builders the comment names as built on `closedSpine`, in the comment's order. */
const NAMED_SPINE_BUILDERS = [
    "dependencyClosureAcceptingFixture",
    "ownPrefixFixtures",
    "proofBarrierFixture",
    "retainedRangeFixtures",
    "forkFixture"
];

/** The denominator the comment states. */
const NAMED_BUILDER_COUNT = 12;

/** The measurement of the module as committed, taken once for the whole suite. */
let measured;

beforeAll(() => {
    measured = measureAsCommitted();
});

describe("the closedSpine basis count published in interleaving_space.js", () => {
    it("is built on closedSpine by exactly the five builders the comment names", () => {
        expect([...measured.spineBuilders].sort()).toEqual([...NAMED_SPINE_BUILDERS].sort());
    });

    it("counts exactly the twelve builders the comment states", () => {
        expect(measured.builders).toHaveLength(NAMED_BUILDER_COUNT);
    });

    it("draws the spine builders from the same set as the denominator", () => {
        const alsoCounted = measured.builders.filter((builder) => measured.spineBuilders.includes(builder));
        expect([...alsoCounted].sort()).toEqual([...measured.spineBuilders].sort());
    });
});
