/**
 * Task execution evaluation logic.
 * Determines which tasks should be executed based on cron schedules and retry timing.
 */

const { getMostRecentExecution } = require("../calculator");
const { isRunning } = require("../task");

/** @typedef {import('../types').Callback} Callback */

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
 * @returns {{
 *   dueTasks: Array<{taskName: string, mode: "retry"|"cron", callback: Callback}>,
 *   stats: {dueRetry: number, dueCron: number, skippedRunning: number, skippedRetryFuture: number, skippedNotDue: number}
 * }}
 */
function evaluateTasksForExecution(tasks, scheduledTasks, now, capabilities) {
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

        const shouldRunCron = lastScheduledFire &&
            (!task.lastAttemptTime || task.lastAttemptTime.isBefore(lastScheduledFire));

        const shouldRunRetry = task.pendingRetryUntil && now.isAfterOrEqual(task.pendingRetryUntil);
        const callback = task.callback;

        if (shouldRunRetry && shouldRunCron) {
            // Both are due - choose the mode based on which is earlier (chronologically smaller)
            if (task.pendingRetryUntil && lastScheduledFire && task.pendingRetryUntil.isBefore(lastScheduledFire)) {
                dueTasks.push({ taskName, mode: "retry", callback });
                task.lastAttemptTime = now;
                dueRetry++;
            } else {
                dueTasks.push({ taskName, mode: "cron", callback });
                task.lastAttemptTime = now;
                dueCron++;
            }
        } else if (shouldRunCron) {
            dueTasks.push({ taskName, mode: "cron", callback });
            task.lastAttemptTime = now;
            dueCron++;
        } else if (shouldRunRetry) {
            dueTasks.push({ taskName, mode: "retry", callback });
            task.lastAttemptTime = now;
            dueRetry++;
        } else if (task.pendingRetryUntil) {
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
