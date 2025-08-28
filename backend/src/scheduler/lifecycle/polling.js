/**
 * Polling execution logic.
 * Handles the core polling behavior including re-entrancy protection.
 */

const { mutateTasks } = require('../persistence');
const { evaluateTasksForExecution } = require('../task_execution');

/** @typedef {import('../types').Callback} Callback */

/**
 * Create a polling function that evaluates and executes due tasks.
 * @param {import('../../capabilities/root').Capabilities} capabilities
 * @param {import('../types').ParsedRegistrations} registrations
 * @param {Set<string>} scheduledTasks
 * @param {ReturnType<import('../task_executor').makeTaskExecutor>} taskExecutor
 * @returns {() => Promise<void>}
 */
function makePollingFunction(capabilities, registrations, scheduledTasks, taskExecutor) {
    const dt = capabilities.datetime;
    let pollInProgress = false; // Guard against re-entrant polls

    return async function poll() {
        // Guard against re-entrant polls
        if (pollInProgress) {
            capabilities.logger.logDebug({ reason: "pollInProgress" }, "PollSkipped");
            return;
        }

        pollInProgress = true;
        try {
            const now = dt.now();
            /** @type {Array<{taskName: string, mode: "retry"|"cron", callback: Callback}>} */
            let dueTasks = [];
            /** @type {{dueRetry: number, dueCron: number, skippedRunning: number, skippedRetryFuture: number, skippedNotDue: number}} */
            let stats = {
                dueRetry: 0,
                dueCron: 0,
                skippedRunning: 0,
                skippedRetryFuture: 0,
                skippedNotDue: 0,
            };

            // Evaluate which tasks should be executed
            await mutateTasks(capabilities, registrations, (tasks) => {
                const result = evaluateTasksForExecution(tasks, scheduledTasks, now, dt, capabilities);
                dueTasks = result.dueTasks;
                stats = result.stats;
            });

            // Execute all due tasks in parallel
            await taskExecutor.executeTasks(dueTasks);

            capabilities.logger.logDebug(
                {
                    due: dueTasks.length,
                    dueRetry: stats.dueRetry,
                    dueCron: stats.dueCron,
                    skippedRunning: stats.skippedRunning,
                    skippedRetryFuture: stats.skippedRetryFuture,
                    skippedNotDue: stats.skippedNotDue,
                },
                "PollSummary"
            );
        } finally {
            pollInProgress = false;
        }
    };
}

module.exports = {
    makePollingFunction,
};