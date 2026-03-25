/**
 * Type definitions for RuntimeStateStorage capabilities.
 */

/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../datetime').Datetime} Datetime */
/** @typedef {import('../temporary').Temporary} Temporary */

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
 * @property {string} [schedulerIdentifier] - Identifier of the scheduler instance that started this task
 */

/**
 * Capabilities needed for RuntimeStateStorage operations and transactions.
 * @typedef {object} RuntimeStateStorageCapabilities
 * @property {Temporary} temporary - The temporary DB capability for runtime state persistence
 * @property {Logger} logger - A logger instance
 * @property {Datetime} datetime - Datetime utilities
 */

/**
 * @typedef {RuntimeStateStorageCapabilities} Capabilities
 */

module.exports = {};
