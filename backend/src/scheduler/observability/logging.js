// @ts-check
/**
 * Logging integration for observability events.
 */

const { EVENTS } = require('./events');
const { logEvent } = require('../logger');

/**
 * Log startup validation.
 * @param {number} taskCount
 * @param {string[]} taskNames
 * @param {import('../types').InstantMs} timestamp
 * @param {import('../../logger').Logger} logger
 */
function logStartupValidated(taskCount, taskNames, timestamp, logger) {
    logEvent(EVENTS.STARTUP_VALIDATED, {
        taskCount,
        taskNames,
        timestamp: timestamp.epochMs,
    }, logger);
}

/**
 * Log task dispatch.
 * @param {string} taskName
 * @param {import('../types').RunId} runId
 * @param {string} mode
 * @param {import('../types').InstantMs} timestamp
 * @param {import('../../logger').Logger} logger
 */
function logTaskDispatched(taskName, runId, mode, timestamp, logger) {
    logEvent(EVENTS.TASK_DISPATCHED, {
        taskName,
        runId: runId.toString(),
        mode,
        timestamp: timestamp.epochMs,
    }, logger);
}

/**
 * Log task start.
 * @param {string} taskName
 * @param {import('../types').RunId} runId
 * @param {string} mode
 * @param {import('../types').InstantMs} timestamp
 * @param {import('../../logger').Logger} logger
 */
function logTaskStarted(taskName, runId, mode, timestamp, logger) {
    logEvent(EVENTS.TASK_STARTED, {
        taskName,
        runId: runId.toString(),
        mode,
        timestamp: timestamp.epochMs,
    }, logger);
}

/**
 * Log task success.
 * @param {string} taskName
 * @param {import('../types').RunId} runId
 * @param {string} mode
 * @param {number} durationMs
 * @param {import('../types').InstantMs} timestamp
 * @param {import('../../logger').Logger} logger
 */
function logTaskSucceeded(taskName, runId, mode, durationMs, timestamp, logger) {
    logEvent(EVENTS.TASK_SUCCEEDED, {
        taskName,
        runId: runId.toString(),
        mode,
        durationMs,
        timestamp: timestamp.epochMs,
    }, logger);
}

/**
 * Log task failure.
 * @param {string} taskName
 * @param {import('../types').RunId} runId
 * @param {string} mode
 * @param {string} errorMessage
 * @param {number} durationMs
 * @param {import('../types').InstantMs} timestamp
 * @param {import('../../logger').Logger} logger
 */
function logTaskFailed(taskName, runId, mode, errorMessage, durationMs, timestamp, logger) {
    logEvent(EVENTS.TASK_FAILED, {
        taskName,
        runId: runId.toString(),
        mode,
        errorMessage,
        durationMs,
        timestamp: timestamp.epochMs,
    }, logger);
}

/**
 * Log retry scheduled.
 * @param {string} taskName
 * @param {import('../types').RunId} runId
 * @param {import('../types').InstantMs} retryAtTimestamp
 * @param {number} delayMs
 * @param {import('../types').InstantMs} timestamp
 * @param {import('../../logger').Logger} logger
 */
function logRetryScheduled(taskName, runId, retryAtTimestamp, delayMs, timestamp, logger) {
    logEvent(EVENTS.RETRY_SCHEDULED, {
        taskName,
        runId: runId.toString(),
        retryAtTimestamp: retryAtTimestamp.epochMs,
        delayMs,
        timestamp: timestamp.epochMs,
    }, logger);
}

module.exports = {
    logStartupValidated,
    logTaskDispatched,
    logTaskStarted,
    logTaskSucceeded,
    logTaskFailed,
    logRetryScheduled,
};