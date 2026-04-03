const {
    MissingFieldError,
    InvalidTypeError,
    InvalidValueError,
    InvalidStructureError,
    InvalidArrayElementError,
    makeInvalidStructureError,
    isTryDeserializeError,
    isMissingFieldError,
    isInvalidTypeError,
    isInvalidValueError,
    isInvalidStructureError,
    isInvalidArrayElementError,
} = require("./errors");

/** @typedef {import("./errors").TryDeserializeError} TryDeserializeError */

/**
 * @typedef {object} OntologyTypeEntry
 * @property {string} name - The name of the type
 * @property {string} description - Description of the type for AI context
 */

/**
 * @typedef {object} OntologyModifierEntry
 * @property {string} name - The name of the modifier
 * @property {string} [only_for_type] - Optional: restricts this modifier to a specific type
 * @property {string} description - Description of the modifier for AI context
 */

/**
 * @typedef {object} Ontology
 * @property {OntologyTypeEntry[]} types - Array of type entries
 * @property {OntologyModifierEntry[]} modifiers - Array of modifier entries
 */

/**
 * @typedef {object} SerializedOntology
 * @property {OntologyTypeEntry[]} types - Array of type entries
 * @property {OntologyModifierEntry[]} modifiers - Array of modifier entries
 */

/**
 * @param {Ontology} ontology
 * @returns {SerializedOntology}
 */
function serialize(ontology) {
    return {
        types: ontology.types.map((t) => {
            /** @type {OntologyTypeEntry} */
            const entry = { name: t.name, description: t.description };
            return entry;
        }),
        modifiers: ontology.modifiers.map((m) => {
            /** @type {OntologyModifierEntry} */
            const entry = { name: m.name, description: m.description };
            if (m.only_for_type !== undefined) {
                entry.only_for_type = m.only_for_type;
            }
            return entry;
        }),
    };
}

/**
 * @param {SerializedOntology} serializedOntology
 * @returns {Ontology}
 */
function deserialize(serializedOntology) {
    return {
        types: serializedOntology.types.map((t) => {
            /** @type {OntologyTypeEntry} */
            const entry = { name: t.name, description: t.description };
            return entry;
        }),
        modifiers: serializedOntology.modifiers.map((m) => {
            /** @type {OntologyModifierEntry} */
            const entry = { name: m.name, description: m.description };
            if (m.only_for_type !== undefined) {
                entry.only_for_type = m.only_for_type;
            }
            return entry;
        }),
    };
}

/**
 * Attempts to deserialize an unknown object into an Ontology.
 * Returns the Ontology on success, or a TryDeserializeError on failure.
 *
 * @param {unknown} obj - The object to attempt to deserialize
 * @returns {Ontology | TryDeserializeError}
 */
function tryDeserialize(obj) {
    try {
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
            return new InvalidStructureError(
                "Object must be a non-null object and not an array",
                obj
            );
        }

        // Validate types field
        if (!("types" in obj)) return new MissingFieldError("types");
        const types = obj.types;
        if (!Array.isArray(types)) {
            return new InvalidTypeError("types", types, "array");
        }

        /** @type {OntologyTypeEntry[]} */
        const validatedTypes = [];
        for (let i = 0; i < types.length; i++) {
            const item = types[i];
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                return new InvalidArrayElementError("types", i, item, "expected non-null object");
            }
            if (!("name" in item)) {
                return new InvalidArrayElementError("types", i, item, "missing required field 'name'");
            }
            if (typeof item.name !== "string") {
                return new InvalidArrayElementError("types", i, item, "field 'name' must be a string");
            }
            if (!("description" in item)) {
                return new InvalidArrayElementError("types", i, item, "missing required field 'description'");
            }
            if (typeof item.description !== "string") {
                return new InvalidArrayElementError("types", i, item, "field 'description' must be a string");
            }
            validatedTypes.push({ name: item.name, description: item.description });
        }

        // Validate modifiers field
        if (!("modifiers" in obj)) return new MissingFieldError("modifiers");
        const modifiers = obj.modifiers;
        if (!Array.isArray(modifiers)) {
            return new InvalidTypeError("modifiers", modifiers, "array");
        }

        /** @type {OntologyModifierEntry[]} */
        const validatedModifiers = [];
        for (let i = 0; i < modifiers.length; i++) {
            const item = modifiers[i];
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                return new InvalidArrayElementError("modifiers", i, item, "expected non-null object");
            }
            if (!("name" in item)) {
                return new InvalidArrayElementError("modifiers", i, item, "missing required field 'name'");
            }
            if (typeof item.name !== "string") {
                return new InvalidArrayElementError("modifiers", i, item, "field 'name' must be a string");
            }
            if (!("description" in item)) {
                return new InvalidArrayElementError("modifiers", i, item, "missing required field 'description'");
            }
            if (typeof item.description !== "string") {
                return new InvalidArrayElementError("modifiers", i, item, "field 'description' must be a string");
            }
            /** @type {OntologyModifierEntry} */
            const modifierEntry = { name: item.name, description: item.description };
            if ("only_for_type" in item) {
                if (typeof item.only_for_type !== "string") {
                    return new InvalidArrayElementError("modifiers", i, item, "field 'only_for_type' must be a string if provided");
                }
                modifierEntry.only_for_type = item.only_for_type;
            }
            validatedModifiers.push(modifierEntry);
        }

        return deserialize({ types: validatedTypes, modifiers: validatedModifiers });
    } catch (error) {
        return new InvalidValueError(
            "unknown",
            obj,
            `Unexpected error during deserialization: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

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
