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
/** @typedef {import('../sleeper').Sleeper} Sleeper */

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
 * @property {number} version - Schema version
 * @property {import('../datetime').DateTime} startTime - When the Volodyslav process started
 * @property {TaskRecord[]} tasks - Persisted task records
 */

/**
 * A record describing a scheduled task persisted in runtime state.
 * @typedef {object} TaskRecord
 * @property {string} name - Task name (unique)
 * @property {string} cronExpression - Cron expression string
 * @property {number} retryDelayMs - Retry delay in milliseconds
 * @property {import('../datetime').DateTime} [lastSuccessTime] - Last successful execution time
 * @property {import('../datetime').DateTime} [lastFailureTime] - Last failed execution time
 * @property {import('../datetime').DateTime} [lastAttemptTime] - Last execution attempt time (success or failure)
 * @property {import('../datetime').DateTime} [pendingRetryUntil] - Retry deadline for failed tasks
 * @property {import('../datetime').DateTime} [lastEvaluatedFire] - Cache of last evaluated cron fire time for performance optimization. This stores the actual fire time (not evaluation time) to enable efficient forward-stepping algorithm that avoids minute-by-minute backward scanning.
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
 * @property {Sleeper} sleeper - A sleeper instance for delays
 */

module.exports = {};
