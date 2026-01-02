/**
 * Sublevel structure and factory for type-safe database operations.
 */

/** @typedef {import('./types').DatabaseValue} DatabaseValue */
/** @typedef {import('./types').Freshness} Freshness */
/** @typedef {import('./batch_types').InputsRecord} InputsRecord */

/**
 * A sublevel for storing node output values.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: the computed value (string, number, object, array, null, boolean)
 * @typedef {any} ValuesLevel
 */

/**
 * A sublevel for storing node freshness state.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: freshness state object
 * @typedef {any} FreshnessLevel
 */

/**
 * A sublevel for storing node input dependencies.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: inputs record with array of dependency names
 * @typedef {any} InputsLevel
 */

/**
 * A sublevel for reverse dependency index.
 * Key: "<input-node>:<dependent-node>" (e.g., "user('alice'):posts('alice')")
 * Value: null (we only care about key existence)
 * @typedef {any} RevdepsLevel
 */

/**
 * Storage container for a single dependency graph schema.
 * @typedef {object} SchemaStorage
 * @property {InputsLevel} inputs - Node inputs index
 * @property {RevdepsLevel} revdeps - Reverse dependencies index
 */

/**
 * A sublevel for storing schema-specific data.
 * Each schema is stored in a nested sublevel accessed by schemaHash.
 * @typedef {any} SchemasLevel
 */

/**
 * Root database structure with typed sublevels.
 * @typedef {object} DatabaseSublevels
 * @property {ValuesLevel} values - Node output values
 * @property {FreshnessLevel} freshness - Node freshness state
 * @property {SchemasLevel} schemas - Schema-specific storage
 */

/**
 * Creates typed sublevel structure for the database.
 * @param {import('level').Level<string, any>} db - Root database instance
 * @returns {DatabaseSublevels}
 */
function makeSublevels(db) {
    const values = db.sublevel("values", { valueEncoding: "json" });
    const freshness = db.sublevel("freshness", { valueEncoding: "json" });
    const schemas = db.sublevel("schemas", { valueEncoding: "json" });

    return {
        values,
        freshness,
        schemas,
    };
}

/**
 * Get or create schema storage for a specific schema hash.
 * @param {SchemasLevel} schemasLevel - The schemas sublevel
 * @param {string} schemaHash - The schema hash
 * @returns {SchemaStorage}
 */
function getSchemaStorage(schemasLevel, schemaHash) {
    const schemaLevel = schemasLevel.sublevel(schemaHash, { valueEncoding: "json" });
    const inputs = schemaLevel.sublevel("inputs", { valueEncoding: "json" });
    const revdeps = schemaLevel.sublevel("revdeps", { valueEncoding: "json" });

    return {
        inputs,
        revdeps,
    };
}

module.exports = {
    makeSublevels,
    getSchemaStorage,
};
