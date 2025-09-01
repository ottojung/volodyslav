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

    let initialized = false;
    let finished = { count: 0 };
    let lastFinishedCount = 0;

    return async function poll() {
        if (initialized && finished.count === lastFinishedCount) {
            return;
        } else {
            lastFinishedCount = finished.count;
        }

        let initResult;
        try {
            initialized = true; // Optimistic. Will revert (in the "catch" clause) if initialization fails.
            const now = dt.now();
            initResult = await mutateTasks(capabilities, registrations, (tasks) => {
                return evaluateTasksForExecution(tasks, scheduledTasks, now, dt, capabilities);
            });
        } catch (error) {
            initialized = false;
            throw error;
        }

        const { dueTasks, stats } = initResult;

        // Execute all due tasks in parallel
        await taskExecutor.executeTasks(dueTasks, finished);

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
