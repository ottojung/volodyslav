const { serialize } = require("../../../ontology");
const { makeUnchanged } = require("../../incremental_graph");

/**
 * @typedef {import('../../interface/default_graph').Capabilities} Capabilities
 * @typedef {object} OntologyBox
 * @property {import('../../../ontology/structure').Ontology | null} value
 */

/** @type {import('../../../ontology/structure').Ontology} */
const EMPTY_ONTOLOGY = Object.freeze({ types: [], modifiers: [] });

/**
 * @returns {OntologyBox}
 */
function makeBox() {
    return {
        value: null,
    };
}

/**
 * @param {OntologyBox} box
 * @param {Capabilities} _capabilities
 * @returns {import('../../incremental_graph/types').NodeDefComputor}
 */
function makeComputor(box, _capabilities) {
    return async (_inputs, oldValue, _bindings) => {
        if (box.value === null) {
            // Initial state before explicit setOntology(). Preserve a persisted old
            // value if one already exists instead of overwriting it with defaults.
            if (oldValue === undefined) {
                return { type: "ontology", ontology: EMPTY_ONTOLOGY };
            }
            return makeUnchanged();
        }

        const nextOntology = box.value;
        const nextValue = { type: "ontology", ontology: nextOntology };

        if (
            oldValue !== undefined &&
            oldValue.type === "ontology" &&
            JSON.stringify(serialize(oldValue.ontology)) === JSON.stringify(serialize(nextOntology))
        ) {
            return makeUnchanged();
        }
        return nextValue;
    };
}

module.exports = {
    makeBox,
    makeComputor,
};
