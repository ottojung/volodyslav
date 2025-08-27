// @ts-check
/**
 * Central structural typedefs for the scheduler.
 */

// Import nominal brands from value objects
/** @typedef {import('./value-objects/instant').InstantMs} InstantMs */
/** @typedef {import('./value-objects/time-duration').TimeDuration} TimeDuration */
/** @typedef {import('./value-objects/poll-interval').PollIntervalMs} PollIntervalMs */
/** @typedef {import('./value-objects/task-id').TaskId} TaskId */
/** @typedef {import('./value-objects/run-id').RunId} RunId */
/** @typedef {import('./value-objects/cron-expression').CronExpression} CronExpression */
/** @typedef {import('./value-objects/task').Task} Task */

/**
 * Optional callback name for logging purposes.
 * @typedef {string} CallbackName
 */

/**
 * Async callback function for task execution.
 * @callback Callback
 * @returns {Promise<void>}
 */

/**
 * Task registration tuple.
 * @typedef {[string, string, Callback, TimeDuration]} Registration
 */

/**
 * Parsed task registration with validated types.
 * @typedef {object} ParsedRegistration
 * @property {TaskId} name - Task identifier
 * @property {CronExpression} cron - Parsed cron expression
 * @property {TimeDuration} retryDelay - Retry delay duration
 */

/**
 * Task definition for persistence.
 * @typedef {object} TaskDefinition
 * @property {TaskId} name - Task identifier
 * @property {CronExpression} cron - Cron expression
 * @property {TimeDuration} retryDelay - Retry delay
 */

/**
 * Task runtime state.
 * @typedef {object} TaskRuntime
 * @property {InstantMs | null} lastSuccessTime - Last successful execution
 * @property {InstantMs | null} lastFailureTime - Last failed execution
 * @property {InstantMs | null} lastAttemptTime - Last execution attempt
 * @property {InstantMs | null} pendingRetryUntil - Retry scheduled until
 * @property {InstantMs | null} lastEvaluatedFire - Last evaluated fire time
 * @property {boolean} isRunning - Whether task is currently executing
 */

/**
 * Complete scheduler state.
 * @typedef {object} SchedulerState
 * @property {string} version - State schema version
 * @property {Array<TaskDefinition & TaskRuntime>} tasks - Task definitions and runtime state
 * @property {InstantMs} lastUpdated - Last state update time
 */

/**
 * Store interface for state persistence.
 * @typedef {object} Store
 * @property {function(function(StoreTxn): Promise<void>): Promise<void>} transaction - Execute transaction
 */

/**
 * Store transaction interface.
 * @typedef {object} StoreTxn
 * @property {function(): Promise<SchedulerState>} getState - Get current state
 * @property {function(SchedulerState): Promise<void>} setState - Set new state
 */

module.exports = {
    // This module only contains type definitions, no runtime exports needed
};