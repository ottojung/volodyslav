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
 * @typedef {object} AllEventsEntry
 * @property {'events'} type - The type of the entry
 * @property {Array<Event>} events - Array of events
 */

/**
 * Database Value Disjoint Union Type
 * @typedef {AllEventsEntry} DatabaseValue
 */

/**
 * Database entry structure
 * @typedef {object} DatabaseEntry
 * @property {DatabaseValue} value - The actual value stored
 * @property {boolean} isDirty - Whether the entry has been modified
 */

module.exports = {};
