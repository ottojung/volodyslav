/**
 * Type definitions for RuntimeStateStorage capabilities.
 */

/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/file').ExistingFile} ExistingFile */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../datetime').Datetime} Datetime */

/**
 * @typedef {object} Capabilities
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {FileCreator} creator - A directory creator instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {Command} git - A command instance for Git operations.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {import('../filesystem/reader').FileReader} reader - A file reader instance.
 * @property {Datetime} datetime - Datetime utilities.
 */

/**
 * Runtime state stored in the persistent storage.
 * @typedef {object} RuntimeState
 * @property {import('../datetime').DateTime} startTime - When the Volodyslav process started
 */

/**
 * Comprehensive capabilities needed for RuntimeStateStorage operations and transactions
 * @typedef {object} RuntimeStateStorageCapabilities
 * @property {import('../filesystem/reader').FileReader} reader - A file reader instance
 * @property {FileWriter} writer - A file writer instance
 * @property {FileCreator} creator - A file creator instance
 * @property {FileChecker} checker - A file checker instance
 * @property {FileDeleter} deleter - A file deleter instance
 * @property {Command} git - A Git command instance
 * @property {Environment} environment - An environment instance
 * @property {Logger} logger - A logger instance
 * @property {Datetime} datetime - Datetime utilities
 */

module.exports = {};
