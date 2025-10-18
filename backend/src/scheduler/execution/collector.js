/**
 * Task execution evaluation logic.
 * Determines which tasks should be executed based on cron schedules and retry timing.
 */

const { getMostRecentExecution } = require("../calculator");
const { isRunning, getPendingRetryUntil } = require("../task");

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

module.exports = {
    evaluateTasksForExecution,
};
