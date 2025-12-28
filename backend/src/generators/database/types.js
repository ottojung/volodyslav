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
 * @typedef {'dirty' | 'potentially-dirty' | 'clean'} Freshness
 */

/**
 * Constructs the freshness key for a given database key.
 * @param {string} key - The database key
 * @returns {string} The freshness key
 */
function freshnessKey(key) {
    return `freshness(${key})`;
}

module.exports = {
    freshnessKey,
};
