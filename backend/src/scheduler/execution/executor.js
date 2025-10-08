const { difference } = require("../../datetime");
/**
 * Task execution for the polling scheduler.
 * Handles running tasks with proper error handling.
 */

/**
 * Error thrown when a task is not found during task execution.
 */
class TaskExecutionNotFoundError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task ${JSON.stringify(taskName)} not found during execution`);
        this.name = "TaskExecutionNotFoundError";
        this.taskName = taskName;
    }
}

/** @typedef {import('../task').Task} Task */
/** @typedef {import('../task').Running} Running */
/** @typedef {import('../task').AwaitingRetry} AwaitingRetry */
/** @typedef {import('../task').AwaitingRun} AwaitingRun */

/**
 * @template T
 * @typedef {import('../types').Transformation<T>} Transformation
 */

/**
 * @typedef {import('../types').Callback} Callback
 */

/**
 * Create a task executor.
 * @param {import('../types').SchedulerCapabilities} capabilities
 * @param {<T>(tr: Transformation<T>) => Promise<T>} mutateTasks
 */
function makeTaskExecutor(capabilities, mutateTasks) {
    const dt = capabilities.datetime;

    /**
     * Execute multiple tasks in parallel.
     * @param {Array<{taskName: string, mode: "retry"|"cron", callback: Callback}>} dueTasks
     * @returns {Promise<void>}
     */
    async function executeTasks(dueTasks) {
        if (dueTasks.length === 0) return;

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
         * @template T
         * @param {(task: Task) => T} transformation
         * @returns {Promise<T>}
         */
        async function mutateThis(transformation) {
            return await mutateTasks((tasks) => {
                const task = tasks.get(taskName);
                if (task === undefined) {
                    throw new TaskExecutionNotFoundError(taskName);
                }
                return transformation(task);
            });
        }

        capabilities.logger.logInfo({ name: taskName, mode }, "TaskRunStarted");

        async function executeIt() {
            try {
                await callback();
                return null;
            } catch (error) {
                if (error instanceof Error) {
                    return error;
                } else {
                    return new Error(`Unknown error: ${error}`);
                }
            }
        }

        const maybeError = await executeIt();
        const end = dt.now();

        if (maybeError === null) {
            await mutateThis((task) => {
                /** @type {AwaitingRun} */
                const newState = {
                    lastAttemptTime: end,
                    lastSuccessTime: end,
                };
                task.state = newState;
            });

            capabilities.logger.logDebug(
                { name: taskName, mode, durationMs: difference(end, startTime).toMillis() },
                `Task ${qname} succeeded`
            );
        } else {
            await mutateThis((task) => {
                const retryAt = end.advance(task.retryDelay);
                /** @type {AwaitingRetry} */
                const newState = {
                    lastFailureTime: end,
                    pendingRetryUntil: retryAt,
                };
                task.state = newState;
            });

            const message = maybeError.message;
            capabilities.logger.logInfo(
                { name: taskName, mode, errorMessage: message },
                `Task ${qname} failed: ${message}`
            );
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
