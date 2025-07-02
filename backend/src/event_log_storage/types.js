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
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {FileCopier} copier - A file copier instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {FileAppender} appender - A file appender instance.
 * @property {FileCreator} creator - A directory creator instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {Command} git - A command instance for Git operations.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {import('../filesystem/reader').FileReader} reader - A file reader instance.
 */

/**
 * Minimal capabilities needed for appending entries to files
 * @typedef {object} AppendCapabilities
 * @property {FileAppender} appender - A file appender instance
 */

/**
 * Minimal capabilities needed for copying assets
 * @typedef {object} CopyAssetCapabilities
 * @property {FileCreator} creator - A file creator instance
 * @property {FileCopier} copier - A file copier instance
 * @property {Environment} environment - An environment instance (for targetPath)
 */

/**
 * Minimal capabilities needed for cleaning up assets
 * @typedef {object} CleanupAssetCapabilities
 * @property {FileDeleter} deleter - A file deleter instance
 * @property {Environment} environment - An environment instance (for targetPath)
 * @property {Logger} logger - A logger instance
 */

/**
 * Minimal capabilities needed for reading existing entries
 * @typedef {object} ReadEntriesCapabilities
 * @property {import('../filesystem/reader').FileReader} reader - A file reader instance
 * @property {Logger} logger - A logger instance
 */

/**
 * Comprehensive capabilities needed for EventLogStorage operations and transactions
 * @typedef {object} EventLogStorageCapabilities
 * @property {import('../filesystem/reader').FileReader} reader - A file reader instance
 * @property {FileWriter} writer - A file writer instance
 * @property {FileCreator} creator - A file creator instance
 * @property {FileChecker} checker - A file checker instance
 * @property {FileDeleter} deleter - A file deleter instance
 * @property {FileCopier} copier - A file copier instance
 * @property {FileAppender} appender - A file appender instance
 * @property {Command} git - A Git command instance
 * @property {Environment} environment - An environment instance
 * @property {Logger} logger - A logger instance
 */

module.exports = {};
