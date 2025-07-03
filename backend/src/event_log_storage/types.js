/**
 * Type definitions for EventLogStorage capabilities.
 */

/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../filesystem/copier').FileCopier} FileCopier */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/file').ExistingFile} ExistingFile */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */

/**
 * @typedef {object} Capabilities
 * @property {FileDeleter} deleter
 * @property {FileCopier} copier
 * @property {FileWriter} writer
 * @property {FileAppender} appender
 * @property {FileCreator} creator
 * @property {FileChecker} checker
 * @property {Command} git
 * @property {Environment} environment
 * @property {Logger} logger
 * @property {import('../filesystem/reader').FileReader} reader
 */

/**
 * @typedef {object} AppendCapabilities
 * @property {FileAppender} appender
 */

/**
 * @typedef {object} CopyAssetCapabilities
 * @property {FileCreator} creator
 * @property {FileCopier} copier
 * @property {Environment} environment
 */

/**
 * @typedef {object} CleanupAssetCapabilities
 * @property {FileDeleter} deleter
 * @property {Environment} environment
 * @property {Logger} logger
 */

/**
 * @typedef {object} ReadEntriesCapabilities
 * @property {import('../filesystem/reader').FileReader} reader
 * @property {Logger} logger
 */

/**
 * @typedef {object} EventLogStorageCapabilities
 * @property {import('../filesystem/reader').FileReader} reader
 * @property {FileWriter} writer
 * @property {FileCreator} creator
 * @property {FileChecker} checker
 * @property {FileDeleter} deleter
 * @property {FileCopier} copier
 * @property {FileAppender} appender
 * @property {Command} git
 * @property {Environment} environment
 * @property {Logger} logger
 */

module.exports = {};
