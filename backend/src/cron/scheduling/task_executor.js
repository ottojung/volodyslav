/**
 * Task execution for the polling scheduler.
 * Handles running tasks with proper error handling.
 */

/** @typedef {import('../task').Task} Task */

/**
 * @template T
 * @typedef {import('./types').Transformation<T>} Transformation
 */

/**
 * @typedef {import('./types').Callback} Callback
 */

/**
 * Create a task executor.
 * @param {import('../../capabilities/root').Capabilities} capabilities
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
        console.log(`runTask started: ${taskName} at ${dt.toNativeDate(startTime).toISOString()}`);

        /**
         * @template T
         * @param {(task: Task) => T} transformation
         * @returns {Promise<T>}
         */
        async function mutateThis(transformation) {
            return await mutateTasks((tasks) => {
                const task = tasks.get(taskName);
                if (task === undefined) {
                    // FIXME: implement proper error reporting.    
                    throw new Error(`Task not found: ${taskName}`);
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
        console.log(`runTask completed: ${taskName} at ${dt.toNativeDate(end).toISOString()}, error: ${maybeError ? maybeError.message : 'none'}`);

        if (maybeError === null) {
            console.log(`Setting success time for ${taskName} to ${dt.toNativeDate(end).toISOString()}`);
            await mutateThis((task) => {
                task.lastSuccessTime = end;
                task.lastFailureTime = undefined;
                task.pendingRetryUntil = undefined;
            });

            capabilities.logger.logInfo(
                { name: taskName, mode, durationMs: end.getTime() - startTime.getTime() },
                `Task ${qname} succeeded`
            );
        } else {
            console.log(`Setting failure time for ${taskName} to ${dt.toNativeDate(end).toISOString()}`);
            await mutateThis((task) => {
                const retryAt = dt.fromEpochMs(end.getTime() + task.retryDelay.toMilliseconds());
                task.lastSuccessTime = undefined;
                task.lastFailureTime = end;
                task.pendingRetryUntil = retryAt;
            });

            const message = maybeError.message;
            capabilities.logger.logInfo(
                { name: taskName, mode, errorMessage: message },
                `Task ${qname} failed: ${message}`
            );
        }
        console.log(`runTask finished updating state for: ${taskName}`);
    }

    return {
        executeTasks,
        runTask,
    };
}

module.exports = {
    makeTaskExecutor,
};
