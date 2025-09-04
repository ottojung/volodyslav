/**
 * Polling execution logic.
 * Handles the core polling behavior including re-entrancy protection.
 */

const { mutateTasks } = require('../persistence');
const { evaluateTasksForExecution } = require('../execution');

/** @typedef {import('../types').Callback} Callback */

/**
 * Create a polling function that evaluates and executes due tasks.
 * @param {import('../../capabilities/root').Capabilities} capabilities
 * @param {import('../types').ParsedRegistrations} registrations
 * @param {Set<string>} scheduledTasks
 * @param {ReturnType<import('../execution').makeTaskExecutor>} taskExecutor
 * @returns {() => Promise<void>}
 */
function makePollingFunction(capabilities, registrations, scheduledTasks, taskExecutor) {
    const dt = capabilities.datetime;
    let parallelCounter = 0;

    async function getDueTasks() {
        try {
            const now = dt.now();
            return await mutateTasks(capabilities, registrations, (tasks) => {
                return evaluateTasksForExecution(tasks, scheduledTasks, now, capabilities);
            });
        } finally {
            parallelCounter--;
        }
    }

    return async function poll() {
        if (parallelCounter > 0) {
            // Somebody is already polling;
            return;
        } else {
            parallelCounter++;
        }

        // Collect tasks and stats.
        const { dueTasks, stats } = await getDueTasks();

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
    };
}

module.exports = {
    makePollingFunction,
};
