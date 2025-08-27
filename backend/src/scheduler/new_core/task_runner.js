/**
 * Task execution engine for the scheduler.
 * Handles running tasks with proper error handling and state management.
 */

const { TaskNotFoundError } = require('../new_errors');
const { isRunning } = require('./state_manager');

/** @typedef {import('./state_manager').Task} Task */
/** @typedef {import('../new_types/task_types').Callback} Callback */
/** @typedef {import('../new_types/task_types').Transformation} Transformation */

/**
 * Create a task runner for executing scheduled tasks.
 * @param {import('../../capabilities/root').Capabilities} capabilities
 * @param {<T>(tr: Transformation<T>) => Promise<T>} mutateTasks
 */
function makeTaskRunner(capabilities, mutateTasks) {
    const dt = capabilities.datetime;

    /**
     * Execute multiple tasks in parallel.
     * @param {Array<{taskName: string, mode: "retry"|"cron", callback: Callback}>} dueTasks
     * @returns {Promise<void>}
     */
    async function executeTasks(dueTasks) {
        if (dueTasks.length === 0) return;

        capabilities.logger.logInfo(
            { taskCount: dueTasks.length, tasks: dueTasks.map(t => t.taskName) },
            `Executing ${dueTasks.length} due tasks`
        );

        // Execute all tasks in parallel
        const promises = dueTasks.map(({ taskName, mode, callback }) => runTask(taskName, mode, callback));
        await Promise.all(promises);
    }

    /**
     * Execute a single task.
     * @param {string} taskName
     * @param {"retry"|"cron"} mode
     * @param {Callback} callback
     */
    async function runTask(taskName, mode, callback) {
        const qname = JSON.stringify(taskName);
        const startTime = dt.now();

        /**
         * Mark task as started by updating lastAttemptTime.
         * @param {Map<string, Task>} tasks
         * @returns {Task}
         */
        function markTaskStarted(tasks) {
            const task = tasks.get(taskName);
            if (!task) {
                throw new TaskNotFoundError(taskName);
            }

            // Verify task is not already running
            if (isRunning(task)) {
                capabilities.logger.logWarning(
                    { taskName, mode },
                    `Task ${qname} is already running, skipping ${mode} execution`
                );
                return task; // Return unchanged task to skip execution
            }

            // Mark as started
            const updatedTask = {
                ...task,
                lastAttemptTime: startTime,
            };
            tasks.set(taskName, updatedTask);
            return updatedTask;
        }

        try {
            // Mark task as started and get current state
            const taskToRun = await mutateTasks(markTaskStarted);
            
            // Skip if task was already running
            if (isRunning(taskToRun) && taskToRun.lastAttemptTime !== startTime) {
                return;
            }

            capabilities.logger.logInfo(
                { taskName, mode, startTime: startTime.toISOString() },
                `Starting task ${qname} (${mode})`
            );

            // Execute the callback
            await callback();

            // Mark task as successful
            const completionTime = dt.now();
            await mutateTasks((tasks) => {
                const task = tasks.get(taskName);
                if (!task) {
                    throw new TaskNotFoundError(taskName);
                }

                const updatedTask = {
                    ...task,
                    lastSuccessTime: completionTime,
                    lastFailureTime: undefined, // Clear failure on success
                    pendingRetryUntil: undefined, // Clear retry state on success
                };
                tasks.set(taskName, updatedTask);
                return updatedTask;
            });

            const duration = completionTime.getTime() - startTime.getTime();
            capabilities.logger.logInfo(
                { taskName, mode, duration, completionTime: completionTime.toISOString() },
                `Task ${qname} completed successfully in ${duration}ms`
            );

        } catch (error) {
            // Mark task as failed
            const failureTime = dt.now();
            await mutateTasks((tasks) => {
                const task = tasks.get(taskName);
                if (!task) {
                    throw new TaskNotFoundError(taskName);
                }

                // Calculate retry time
                const retryDelayMs = task.retryDelay.toMilliseconds();
                const retryUntil = dt.fromEpochMs(failureTime.getTime() + retryDelayMs);

                const updatedTask = {
                    ...task,
                    lastFailureTime: failureTime,
                    pendingRetryUntil: retryUntil,
                };
                tasks.set(taskName, updatedTask);
                return updatedTask;
            });

            const duration = failureTime.getTime() - startTime.getTime();
            const retryDelayMs = (await mutateTasks(tasks => tasks.get(taskName)?.retryDelay.toMilliseconds() || 0));
            
            capabilities.logger.logError(
                { 
                    taskName, 
                    mode, 
                    duration, 
                    error: error instanceof Error ? error.message : String(error),
                    retryDelayMs,
                    failureTime: failureTime.toISOString() 
                },
                `Task ${qname} failed after ${duration}ms, will retry in ${retryDelayMs}ms`
            );

            // Log the full error for debugging
            capabilities.logger.logDebug(
                { taskName, error },
                `Full error details for task ${qname}`
            );
        }
    }

    return {
        executeTasks,
        runTask,
    };
}

module.exports = {
    makeTaskRunner,
};