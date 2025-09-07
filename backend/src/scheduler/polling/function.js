/**
 * Polling execution logic.
 * Handles the core polling behavior with collection exclusivity optimization.
 * 
 * IMPORTANT: The polling loop is intentionally reentrant for task execution.
 * This reentrancy is essential because long-running tasks must not block newly 
 * due tasks from being executed. Task execution happens in parallel to ensure
 * the scheduler remains responsive regardless of individual task duration.
 * 
 * The only exclusivity protection is during the collection phase: when a thread
 * starts collecting due tasks and sees another thread is already collecting
 * (via parallelCounter), it exits early. This optimization reduces wasteful
 * duplicate collection work, not reentrancy itself.
 */

const { mutateTasks } = require('../persistence');
const { evaluateTasksForExecution } = require('../execution');

/** @typedef {import('../types').Callback} Callback */

/**
 * Create a polling function that evaluates and executes due tasks.
 * @param {import('../types').SchedulerCapabilities} capabilities
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
        // Collection exclusivity optimization: prevent overlapping collection phases
        // to reduce wasteful duplicate work. Task execution itself remains reentrant.
        if (parallelCounter > 0) {
            // Another thread is already collecting due tasks; skip to avoid duplication
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
