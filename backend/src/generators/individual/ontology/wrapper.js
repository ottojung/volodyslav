const { serialize } = require("../../../ontology");
const { makeUnchanged } = require("../../incremental_graph");

/**
 * @typedef {import('../../interface/default_graph').Capabilities} Capabilities
 * @typedef {object} OntologyBox
 * @property {import('../../../ontology/structure').Ontology | null} value
 */

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
            if (oldValue === undefined) {
                return { type: "ontology", ontology: null };
            } else {
                return makeUnchanged();
            }
        }

        const nextValue = { type: "ontology", ontology: box.value };
        if (
            oldValue !== undefined &&
            oldValue.type === "ontology" &&
            JSON.stringify(
                oldValue.ontology === null ? null : serialize(oldValue.ontology)
            ) === JSON.stringify(
                nextValue.ontology === null ? null : serialize(nextValue.ontology)
            )
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
