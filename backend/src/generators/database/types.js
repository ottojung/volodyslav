/**
 * Type definitions for Database capabilities.
 */

/** @typedef {import('../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../logger').Logger} Logger */

/**
 * Environment with pathToVolodyslavDataDirectory method
 * @typedef {object} DatabaseEnvironment
 * @property {() => string} pathToVolodyslavDataDirectory - Get path to Volodyslav data directory
 */

/**
 * Capabilities needed for database operations
 * @typedef {object} DatabaseCapabilities
 * @property {FileChecker} checker - A file checker instance
 * @property {FileCreator} creator - A file creator instance
 * @property {DatabaseEnvironment} environment - An environment instance
 * @property {Logger} logger - A logger instance
 */

/**
 * @typedef {import('../../event').Event} Event
 */

/**
 * @typedef {import('../individual/meta_events').MetaEvent} MetaEvent
 */

/**
 * @typedef {import('../individual/event_context/compute').EventContextEntry} ContextEntry
 */

/**
 * @typedef {object} AllEventsEntry
 * @property {'all_events'} type - The type of the entry
 * @property {Array<Event>} events - Array of events
 */

/**
 * @typedef {object} MetaEventsEntry
 * @property {'meta_events'} type - The type of the entry
 * @property {Array<MetaEvent>} meta_events - Array of meta events
 */

/**
 * @typedef {object} EventContextDatabaseEntry
 * @property {'event_context'} type - The type of the entry
 * @property {Array<ContextEntry>} contexts - Array of event contexts
 */

/**
 * Database Value Disjoint Union Type
 * @typedef {AllEventsEntry | MetaEventsEntry | EventContextDatabaseEntry} DatabaseValue
 */

/**
 * Freshness state for a database value
 * @typedef {'up-to-date' | 'potentially-outdated'} Freshness
 */

/**
 * Constructs the freshness key for a given database key.
 * @param {string} key - The database key
 * @returns {string} The freshness key
 */
function freshnessKey(key) {
    return `freshness:${key}`;
}

/**
 * Type guard to check if a value is a Freshness state.
 * @param {unknown} value
 * @returns {value is Freshness}
 */
function isFreshness(value) {
    return value === "up-to-date" || value === "potentially-outdated";
}

/**
 * Type guard to check if a value is a DatabaseValue.
 * Since DatabaseValue is a union of specific object types, we check if it's
 * an object and not a Freshness string.
 * @param {unknown} value
 * @returns {value is DatabaseValue}
 */
function isDatabaseValue(value) {
    return (
        value !== null &&
        value !== undefined &&
        typeof value === "object" &&
        !isFreshness(value)
    );
}

/**
 * A database put operation.
 * @typedef {object} DatabasePutOperation
 * @property {'put'} type - Operation type
 * @property {string} key - The key to store
 * @property {DatabaseValue | Freshness} value - The value to store
 */

/**
 * A database delete operation.
 * @typedef {object} DatabaseDelOperation
 * @property {'del'} type - Operation type
 * @property {string} key - The key to delete
 */

/**
 * A batch operation for the database.
 * @typedef {DatabasePutOperation | DatabaseDelOperation} DatabaseBatchOperation
 */

/**
 * A record storing the input dependencies of a node.
 * @typedef {object} InputsRecord
 * @property {string[]} inputs - Array of canonical input node names
 */

/**
 * @template F
 * @template K
 * @template V
 * @typedef {import('abstract-level').AbstractLevel<F, K, V>} AbstractLevel
 */

/**
 * @typedef {string | Buffer<ArrayBufferLike> | Uint8Array<ArrayBufferLike>} SublevelFormat
 */

/**
 * @template K
 * @template V
 * @typedef {AbstractLevel<SublevelFormat, K, V>} SimpleSublevel
 */

module.exports = {
    freshnessKey,
    isFreshness,
    isDatabaseValue,
};
