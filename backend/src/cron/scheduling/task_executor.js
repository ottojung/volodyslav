/**
 * Task execution and concurrency management for the polling scheduler.
 * Handles running tasks with proper concurrency limits and error handling.
 */

/** @typedef {import('../polling_scheduler').Task} Task */

/**
 * Create a task executor with concurrency management.
 * @param {import('../../capabilities/root').Capabilities} capabilities
 * @param {number} maxConcurrentTasks
 * @param {() => Promise<void>} persistState
 * @returns {{executeTasks: (dueTasks: Array<{task: Task, mode: "retry"|"cron"}>) => Promise<number>, runTask: (task: Task, mode: "retry"|"cron") => Promise<void>}}
 */
function makeTaskExecutor(capabilities, maxConcurrentTasks, persistState) {
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

        task.running = true;
        runningTasksCount++;
        const startTime = dt.toNativeDate(dt.now());
        task.lastAttemptTime = startTime;
        capabilities.logger.logInfo({ name: task.name, mode }, "TaskRunStarted");
        
        try {
            const result = task.callback();
            if (result instanceof Promise) {
                await result;
            }
            const end = dt.toNativeDate(dt.now());
            task.lastSuccessTime = end;
            task.lastFailureTime = undefined;
            task.pendingRetryUntil = undefined;
            
            capabilities.logger.logInfo(
                { name: task.name, mode, durationMs: end.getTime() - startTime.getTime() },
                "TaskRunSuccess"
            );
            
            // Persist state after success
            try {
                await persistState();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                capabilities.logger.logError({ message }, "StateWriteFailedAfterSuccess");
            }
        } catch (error) {
            const end = dt.toNativeDate(dt.now());
            task.lastFailureTime = end;
            const retryAt = new Date(end.getTime() + task.retryDelay.toMilliseconds());
            task.pendingRetryUntil = retryAt;
            const message = error instanceof Error ? error.message : String(error);
            
            capabilities.logger.logInfo(
                { name: task.name, mode, errorMessage: message, retryAtISO: retryAt.toISOString() },
                "TaskRunFailure"
            );
            
            // Persist state after failure
            try {
                await persistState();
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                capabilities.logger.logError({ message }, "StateWriteFailedAfterFailure");
            }
        } finally {
            task.running = false;
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