/**
 * Task execution and concurrency management for the polling scheduler.
 * Handles running tasks with proper concurrency limits and error handling.
 */

/** @typedef {import('../polling_scheduler').Task} Task */

/**
 * Create a task executor with concurrency management.
 * @param {import('../../capabilities/root').Capabilities} _capabilities
 * @param {number} maxConcurrentTasks
 * @param {(taskName: string) => Promise<void>} executeTask
 * @returns {{executeTasks: (dueTasks: Array<{name: string, mode: "retry"|"cron"}>) => Promise<number>}}
 */
function makeTaskExecutor(_capabilities, maxConcurrentTasks, executeTask) {
    /**
     * Execute multiple tasks with concurrency control.
     * @param {Array<{name: string, mode: "retry"|"cron"}>} dueTasks
     * @returns {Promise<number>} Number of tasks skipped due to concurrency limits
     */
    async function executeTasks(dueTasks) {
        if (dueTasks.length === 0) return 0;

        let skippedConcurrency = 0;

        // Execute all tasks in parallel if within limit
        if (dueTasks.length <= maxConcurrentTasks) {
            const promises = dueTasks.map(({ name }) => executeTask(name));
            await Promise.all(promises);
            return 0;
        } else {
            // More tasks than concurrency limit - some will be deferred
            skippedConcurrency = dueTasks.length - maxConcurrentTasks;

            // Use proper concurrency control for more tasks than the limit
            let index = 0;
            const executing = new Set();

            while (index < dueTasks.length || executing.size > 0) {
                // Start tasks up to the concurrency limit
                while (executing.size < maxConcurrentTasks && index < dueTasks.length) {
                    const dueTask = dueTasks[index++];
                    if (!dueTask) continue;

                    const { name } = dueTask;
                    const promise = executeTask(name);
                    executing.add(promise);

                    // Remove promise when it completes
                    promise.finally(() => executing.delete(promise));
                }

                // Wait for at least one task to complete before continuing
                if (executing.size > 0) {
                    await Promise.race(Array.from(executing));
                }
            }

            return skippedConcurrency;
        }
    }

    return {
        executeTasks,
    };
}

module.exports = {
    makeTaskExecutor,
};