const {
    serialize,
    deserialize,
    tryDeserialize,
    makeInvalidStructureError,
    isTryDeserializeError,
    isMissingFieldError,
    isInvalidTypeError,
    isInvalidValueError,
    isInvalidStructureError,
    isInvalidArrayElementError,
} = require("./structure");

/** @typedef {import('./structure').Ontology} Ontology */
/** @typedef {import('./structure').SerializedOntology} SerializedOntology */
/** @typedef {import('./structure').OntologyTypeEntry} OntologyTypeEntry */
/** @typedef {import('./structure').OntologyModifierEntry} OntologyModifierEntry */

module.exports = {
    serialize,
    deserialize,
    tryDeserialize,
    makeInvalidStructureError,
    isTryDeserializeError,
    isMissingFieldError,
    isInvalidTypeError,
    isInvalidValueError,
    isInvalidStructureError,
    isInvalidArrayElementError,
};
