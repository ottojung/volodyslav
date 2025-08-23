/**
 * Task execution for the polling scheduler.
 * Handles running tasks with proper error handling.
 */

/** @typedef {import('../polling_scheduler').Task} Task */

/**
 * Create a task executor.
 * @param {import('../../capabilities/root').Capabilities} capabilities
 * @param {() => Promise<void>} persistState
 * @returns {{executeTasks: (dueTasks: Array<{task: Task, mode: "retry"|"cron"}>) => Promise<void>, runTask: (task: Task, mode: "retry"|"cron") => Promise<void>}}
 */
function makeTaskExecutor(capabilities, persistState) {
    const dt = capabilities.datetime;

    /**
     * Execute multiple tasks in parallel.
     * @param {Array<{task: Task, mode: "retry"|"cron"}>} dueTasks
     * @returns {Promise<void>}
     */
    async function executeTasks(dueTasks) {
        if (dueTasks.length === 0) return;

        // Execute all tasks in parallel
        const promises = dueTasks.map(({ task, mode }) => runTask(task, mode));
        await Promise.all(promises);
        
        // Persist state once after all tasks complete (atomic persistence)
        try {
            await persistState();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            capabilities.logger.logError({ message }, "StateWriteFailedAfterBatchExecution");
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
            
            // State will be persisted atomically after all tasks in batch complete
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
            
            // State will be persisted atomically after all tasks in batch complete
        } finally {
            task.running = false;
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