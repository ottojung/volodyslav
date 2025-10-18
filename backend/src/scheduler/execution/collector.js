/**
 * Task execution evaluation logic.
 * Determines which tasks should be executed based on cron schedules and retry timing.
 */

const { getMostRecentExecution, getNextExecution } = require("../calculator");
const { isRunning, getPendingRetryUntil } = require("../task");
const { difference, fromSeconds, fromHours } = require("../../datetime");

/** @typedef {import('../types').Callback} Callback */
/** @typedef {import('../task').Running} Running */
/** @typedef {import('../task').AwaitingRetry} AwaitingRetry */
/** @typedef {import('../task').AwaitingRun} AwaitingRun */

/**
 * Error thrown when a task is not found during evaluation for execution.
 */
class TaskEvaluationNotFoundError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task ${JSON.stringify(taskName)} not found during evaluation`);
        this.name = "TaskEvaluationNotFoundError";
        this.taskName = taskName;
    }
}

/**
 * Evaluates tasks to determine which ones should be executed.
 * @param {Map<string, import('../task').Task>} tasks - Task map
 * @param {Set<string>} scheduledTasks - Set of scheduled task names
 * @param {import('../../datetime').DateTime} now - Current datetime
 * @param {import('../types').SchedulerCapabilities} capabilities - Capabilities for logging
 * @param {string} schedulerIdentifier - Identifier of the current scheduler instance
 * @returns {{
 *   dueTasks: Array<{taskName: string, mode: "retry"|"cron", callback: Callback}>,
 *   stats: {dueRetry: number, dueCron: number, skippedRunning: number, skippedRetryFuture: number, skippedNotDue: number}
 * }}
 */
function evaluateTasksForExecution(tasks, scheduledTasks, now, capabilities, schedulerIdentifier) {
    let dueRetry = 0;
    let dueCron = 0;
    let skippedRunning = 0;
    let skippedRetryFuture = 0;
    let skippedNotDue = 0;

    // Collect all due tasks for parallel execution
    /** @type {Array<{taskName: string, mode: "retry"|"cron", callback: Callback}>} */
    const dueTasks = [];

    for (const taskName of scheduledTasks) {
        const task = tasks.get(taskName);
        if (task === undefined) {
            throw new TaskEvaluationNotFoundError(taskName);
        }

        if (isRunning(task)) {
            skippedRunning++;
            capabilities.logger.logDebug({ name: taskName, reason: "running" }, "Task was skipped because it is already running");
            continue;
        }

        // Check both cron schedule and retry timing
        const lastScheduledFire = getMostRecentExecution(task.parsedCron, now);
        const hasLastAttemptTime = 'lastAttemptTime' in task.state;
        const shouldRunCron = hasLastAttemptTime && (
            task.state.lastAttemptTime === null ||
            task.state.lastAttemptTime.isBefore(lastScheduledFire)
        );
        const pendingRetryUntil = getPendingRetryUntil(task);
        const shouldRunRetry = pendingRetryUntil !== undefined && now.isAfterOrEqual(pendingRetryUntil);
        const callback = task.callback;

        if (shouldRunRetry) {
            /** @type {Running} */
            const newState = {
                lastAttemptTime: now,
                schedulerIdentifier: schedulerIdentifier
            };
            task.state = newState;
            dueTasks.push({ taskName, mode: "retry", callback });
            dueRetry++;
        } else if (shouldRunCron) {
            /** @type {Running} */
            const newState = {
                lastAttemptTime: now,
                schedulerIdentifier: schedulerIdentifier
            };
            task.state = newState;
            dueTasks.push({ taskName, mode: "cron", callback });
            dueCron++;
        } else if (pendingRetryUntil !== undefined) {
            skippedRetryFuture++;
            capabilities.logger.logDebug({ name: taskName, reason: "retryNotDue" }, "Task skipped because retry time is in the future");
        } else {
            skippedNotDue++;
            capabilities.logger.logDebug({ name: taskName, reason: "notDue" }, "Task skipped because it is not due");
        }
    }

    return {
        dueTasks,
        stats: {
            dueRetry,
            dueCron,
            skippedRunning,
            skippedRetryFuture,
            skippedNotDue,
        }
    };
}

/**
 * Minimum sleep duration to prevent busy-waiting.
 */
const MINIMUM_SLEEP_DURATION = fromSeconds(1);

/**
 * Maximum sleep duration as a safety backstop.
 */
const MAXIMUM_SLEEP_DURATION = fromHours(10);

/**
 * Calculate the duration until the next task becomes due.
 * Considers both cron schedules and retry timings.
 * @param {Map<string, import('../task').Task>} tasks - Task map
 * @param {Set<string>} scheduledTasks - Set of scheduled task names
 * @param {import('../../datetime').DateTime} now - Current datetime
 * @param {import('../types').SchedulerCapabilities} capabilities - Capabilities for logging
 * @returns {import('../../datetime').Duration} Duration to sleep until next task is due
 */
function calculateNextDueTime(tasks, scheduledTasks, now, capabilities) {
    /** @type {import('../../datetime').DateTime | null} */
    let earliestDueTime = null;

    for (const taskName of scheduledTasks) {
        const task = tasks.get(taskName);
        if (task === undefined) {
            throw new TaskEvaluationNotFoundError(taskName);
        }

        // Skip running tasks - they don't have a "next due time"
        if (isRunning(task)) {
            continue;
        }

        // Check retry timing first (higher priority)
        const pendingRetryUntil = getPendingRetryUntil(task);
        if (pendingRetryUntil !== undefined) {
            if (earliestDueTime === null || pendingRetryUntil.isBefore(earliestDueTime)) {
                earliestDueTime = pendingRetryUntil;
            }
        }

        // Check cron schedule for next execution
        try {
            const nextCronExecution = getNextExecution(task.parsedCron, now);
            if (earliestDueTime === null || nextCronExecution.isBefore(earliestDueTime)) {
                earliestDueTime = nextCronExecution;
            }
        } catch (err) {
            // If we can't calculate next execution, log and skip this task
            capabilities.logger.logError(
                { name: taskName, error: err instanceof Error ? err.message : String(err) },
                "Failed to calculate next cron execution for task"
            );
        }
    }

    // Calculate duration from now to earliest due time
    if (earliestDueTime === null) {
        // No tasks scheduled or all running - use maximum sleep
        return MAXIMUM_SLEEP_DURATION;
    }

    // If earliest due time is in the past or now, return minimum duration
    if (earliestDueTime.isBeforeOrEqual(now)) {
        return MINIMUM_SLEEP_DURATION;
    }

    // Calculate the duration until the earliest due time
    const durationUntilDue = difference(earliestDueTime, now);
    const durationMs = durationUntilDue.toMillis();

    // Apply min/max bounds
    const minMs = MINIMUM_SLEEP_DURATION.toMillis();
    const maxMs = MAXIMUM_SLEEP_DURATION.toMillis();
    const boundedMs = Math.max(minMs, Math.min(maxMs, durationMs));

    capabilities.logger.logDebug(
        {
            earliestDueTime: earliestDueTime.toISOString(),
            durationMs: boundedMs,
            unboundedDurationMs: durationMs,
        },
        "Calculated next due time"
    );

    return fromSeconds(boundedMs / 1000);
}

module.exports = {
    evaluateTasksForExecution,
    calculateNextDueTime,
};
