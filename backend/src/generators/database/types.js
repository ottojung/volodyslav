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
 * Database entry structure
 * @typedef {object} DatabaseEntry
 * @property {object} value - The actual value stored
 * @property {boolean} isDirty - Whether the entry has been modified
 */

module.exports = {};
