// @ts-check
/**
 * Backward compatibility module for task executor.
 * This module provides compatibility with the old task executor API.
 */

const { Executor } = require('../runtime/executor');

/**
 * Task executor wrapper for backward compatibility.
 */
class TaskExecutor {
    /** @type {import('../runtime/executor').Executor} */
    executor;

    /**
     * @param {import('../runtime/executor').Executor} executor
     */
    constructor(executor) {
        this.executor = executor;
    }

    /**
     * Run a task with the given mode.
     * @param {object} task - Task object with name and callback
     * @param {string} mode - Execution mode ('cron' or 'retry')
     * @returns {Promise<void>}
     */
    async runTask(task, mode) {
        // Type assertions for TypeScript compatibility
        const taskWithProps = /** @type {{ name: string, callback: () => Promise<void> }} */ (task);
        await this.executor.execute(taskWithProps.name, mode, taskWithProps.callback);
    }

    /**
     * Wait for all running tasks to complete.
     * @returns {Promise<void>}
     */
    async waitForCompletion() {
        await this.executor.waitForCompletion();
    }
}

/**
 * Create a task executor instance.
 * @param {object} capabilities - Capabilities object
 * @param {Function} persistStateFn - State persistence function
 * @returns {TaskExecutor}
 */
function makeTaskExecutor(capabilities, persistStateFn) {
    // Create a mock store and logger for compatibility
    const store = {
        persist: persistStateFn || (() => {}),
        /** @param {Function} callback */
        async transaction(callback) {
            // Mock transaction for compatibility
            const mockTxn = {
                async getState() { return { tasks: [] }; },
                /** @param {any} _state */
                async setState(_state) { /* no-op */ }
            };
            await callback(mockTxn);
        }
    };
    
    const capabilitiesWithLogger = /** @type {{ logger?: any }} */ (capabilities);
    const logger = capabilitiesWithLogger?.logger || {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
        logDebug: () => {},
        logInfo: () => {},
        logWarning: () => {},
        logError: () => {},
    };

    const executor = new Executor(store, logger);
    return new TaskExecutor(executor);
}

module.exports = {
    makeTaskExecutor,
    TaskExecutor,
};