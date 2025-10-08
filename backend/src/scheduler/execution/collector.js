/**
 * Task execution evaluation logic.
 * Determines which tasks should be executed based on cron schedules and retry timing.
 */

const { getMostRecentExecution } = require("../calculator");
const { isRunning } = require("../task");

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
            capabilities.logger.logDebug({ name: taskName, reason: "running" }, "TaskSkip");
            continue;
        }

        // Check both cron schedule and retry timing
        const lastScheduledFire = getMostRecentExecution(task.parsedCron, now);
        let shouldRunCron = false;
        if ('lastAttemptTime' in task.state) {
            const lastAttemptTime = task.state.lastAttemptTime;
            shouldRunCron = lastAttemptTime === null || lastAttemptTime.isBefore(lastScheduledFire);
        } else if ('lastFailureTime' in task.state) {
            shouldRunCron = task.state.lastFailureTime.isBefore(lastScheduledFire);
        }
        const shouldRunRetry = 'pendingRetryUntil' in task.state && now.isAfterOrEqual(task.state.pendingRetryUntil);
        const callback = task.callback;

        if (shouldRunCron) {
            dueTasks.push({ taskName, mode: "cron", callback });
            /** @type {Running} */
            const newState = {
                lastAttemptTime: now,
                schedulerIdentifier: schedulerIdentifier
            };
            task.state = newState;
            dueCron++;
        } else if (shouldRunRetry) {
            dueTasks.push({ taskName, mode: "retry", callback });
            /** @type {Running} */
            const newState = {
                lastAttemptTime: now,
                schedulerIdentifier: schedulerIdentifier
            };
            task.state = newState;
            dueRetry++;
        } else if ('pendingRetryUntil' in task.state) {
            skippedRetryFuture++;
            capabilities.logger.logDebug({ name: taskName, reason: "retryNotDue" }, "TaskSkip");
        } else {
            skippedNotDue++;
            capabilities.logger.logDebug({ name: taskName, reason: "notDue" }, "TaskSkip");
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
