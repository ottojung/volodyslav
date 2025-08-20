/**
 * Task execution and concurrency management for the polling scheduler.
 * Handles running tasks with proper concurrency limits and error handling.
 */

/** @typedef {import('../polling_scheduler').Task} Task */

/**
 * Create a task executor with concurrency management.
 * @param {import('../../capabilities/root').Capabilities} capabilities
 * @param {number} maxConcurrentTasks
 * @param {(task: Task, updates: Partial<Task>) => Promise<void>} updateTask
 * @returns {{executeTasks: (dueTasks: Array<{task: Task, mode: "retry"|"cron"}>) => Promise<number>, runTask: (task: Task, mode: "retry"|"cron") => Promise<void>}}
 */
function makeTaskExecutor(capabilities, maxConcurrentTasks, updateTask) {
    const dt = capabilities.datetime;
    let runningTasksCount = 0;

    /**
     * Execute multiple tasks with concurrency control.
     * @param {Array<{task: Task, mode: "retry"|"cron"}>} dueTasks
     * @returns {Promise<number>} Number of tasks skipped due to concurrency limits
     */
    async function executeTasks(dueTasks) {
        if (dueTasks.length === 0) return 0;

        let skippedConcurrency = 0;

        // Execute all tasks in parallel if within limit and no other tasks running
        if (dueTasks.length <= maxConcurrentTasks && runningTasksCount === 0) {
            const promises = dueTasks.map(({ task, mode }) => runTask(task, mode));
            await Promise.all(promises);
            return 0;
        }

        // Use concurrency control
        if (dueTasks.length <= maxConcurrentTasks) {
            // If we have fewer tasks than the limit, just run them all in parallel
            const promises = dueTasks.map(({ task, mode }) => runTask(task, mode));
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

                    const { task, mode } = dueTask;
                    const promise = runTask(task, mode);
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

    /**
     * Execute a single task.
     * @param {Task} task
     * @param {"retry"|"cron"} mode
     */
    async function runTask(task, mode) {
        if (task.callback === null) {
            capabilities.logger.logWarning({ name: task.name }, "TaskSkippedNoCallback");
            return;
        }

        // Start task execution - batch all updates into a single transaction
        runningTasksCount++;
        const startTime = dt.toNativeDate(dt.now());
        
        // Mark running and set attempt time atomically
        await updateTask(task, { 
            running: true,
            lastAttemptTime: startTime
        });
        
        capabilities.logger.logInfo({ name: task.name, mode }, "TaskRunStarted");
        
        try {
            const result = task.callback();
            if (result instanceof Promise) {
                await result;
            }
            const end = dt.toNativeDate(dt.now());
            
            // Update task state on success - single atomic transaction
            await updateTask(task, {
                lastSuccessTime: end,
                lastFailureTime: undefined,
                pendingRetryUntil: undefined,
                running: false,
            });
            
            capabilities.logger.logInfo(
                { name: task.name, mode, durationMs: end.getTime() - startTime.getTime() },
                "TaskRunSuccess"
            );
        } catch (error) {
            const end = dt.toNativeDate(dt.now());
            const retryAt = new Date(end.getTime() + task.retryDelay.toMilliseconds());
            const message = error instanceof Error ? error.message : String(error);
            
            // Update task state on failure - single atomic transaction
            await updateTask(task, {
                lastFailureTime: end,
                pendingRetryUntil: retryAt,
                running: false,
            });
            
            capabilities.logger.logInfo(
                { name: task.name, mode, errorMessage: message, retryAtISO: retryAt.toISOString() },
                "TaskRunFailure"
            );
        } finally {
            runningTasksCount--;
        }
    }

    return {
        executeTasks,
        runTask,
    };
}

module.exports = {
    makeTaskExecutor,
};