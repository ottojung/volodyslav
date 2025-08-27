// @ts-check
/**
 * Event constants and payload shapes for observability.
 */

/**
 * Event names.
 */
const EVENTS = {
    STARTUP_VALIDATED: 'startup_validated',
    TASK_DISPATCHED: 'task_dispatched',
    TASK_STARTED: 'task_started',
    TASK_SUCCEEDED: 'task_succeeded',
    TASK_FAILED: 'task_failed',
    RETRY_SCHEDULED: 'retry_scheduled',
};

/**
 * Startup validation event payload.
 * @typedef {object} StartupValidatedPayload
 * @property {number} taskCount - Number of tasks validated
 * @property {string[]} taskNames - Names of validated tasks
 * @property {number} timestamp - Validation timestamp
 */

/**
 * Task dispatched event payload.
 * @typedef {object} TaskDispatchedPayload
 * @property {string} taskName - Task name
 * @property {import('../types').RunId} runId - Run identifier
 * @property {string} mode - Execution mode ('cron' or 'retry')
 * @property {number} timestamp - Dispatch timestamp
 */

/**
 * Task started event payload.
 * @typedef {object} TaskStartedPayload
 * @property {string} taskName - Task name
 * @property {import('../types').RunId} runId - Run identifier
 * @property {string} mode - Execution mode ('cron' or 'retry')
 * @property {number} timestamp - Start timestamp
 */

/**
 * Task succeeded event payload.
 * @typedef {object} TaskSucceededPayload
 * @property {string} taskName - Task name
 * @property {import('../types').RunId} runId - Run identifier
 * @property {string} mode - Execution mode ('cron' or 'retry')
 * @property {number} durationMs - Execution duration in milliseconds
 * @property {number} timestamp - Success timestamp
 */

/**
 * Task failed event payload.
 * @typedef {object} TaskFailedPayload
 * @property {string} taskName - Task name
 * @property {import('../types').RunId} runId - Run identifier
 * @property {string} mode - Execution mode ('cron' or 'retry')
 * @property {string} errorMessage - Error message
 * @property {number} durationMs - Execution duration in milliseconds
 * @property {number} timestamp - Failure timestamp
 */

/**
 * Retry scheduled event payload.
 * @typedef {object} RetryScheduledPayload
 * @property {string} taskName - Task name
 * @property {import('../types').RunId} runId - Run identifier
 * @property {number} retryAtTimestamp - When the retry is scheduled
 * @property {number} delayMs - Retry delay in milliseconds
 * @property {number} timestamp - Scheduling timestamp
 */

module.exports = {
    EVENTS,
};