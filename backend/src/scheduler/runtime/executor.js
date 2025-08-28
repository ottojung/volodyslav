// @ts-check
/**
 * Task execution with mutex protection and state management.
 */

// Module-level imports to avoid Jest teardown issues
const { newRunId } = require('../value-objects/run-id');
const { now } = require('../time/clock');
const {
    logTaskStarted,
    logTaskSucceeded,
    logTaskFailed,
    logRetryScheduled,
} = require('../observability/logging');
const { toString: taskIdToString } = require('../value-objects/task-id');
const { calculateRetryTime } = require('../plan/planner');

/**
 * Task executor with non-overlap protection.
 */
class Executor {
    /** @type {Map<string, Promise<void>>} */
    runningTasks;

    /** @type {import('../types').Store} */
    store;

    /** @type {import('../../logger').Logger} */
    logger;

    /**
     * @param {import('../types').Store} store
     * @param {import('../../logger').Logger} logger
     */
    constructor(store, logger) {
        this.runningTasks = new Map();
        this.store = store;
        this.logger = logger;
    }

    /**
     * Wait for all running tasks to complete.
     * @returns {Promise<void>}
     */
    async waitForCompletion() {
        if (this.runningTasks.size === 0) {
            return;
        }
        
        // Wait for all running tasks to complete
        await Promise.all(this.runningTasks.values());
    }

    /**
     * Execute a task if not already running.
     * @param {string} taskName
     * @param {string} mode - 'cron' or 'retry'
     * @param {import('../types').Callback} callback
     * @returns {Promise<void>}
     */
    async execute(taskName, mode, callback) {
        // Check if task is already running
        if (this.runningTasks.has(taskName)) {
            this.logger.logDebug({ taskName, mode }, "Task already running, skipping");
            return;
        }

        // Create execution promise
        const executionPromise = this.executeTask(taskName, mode, callback);
        
        // Track running task
        this.runningTasks.set(taskName, executionPromise);
        
        try {
            await executionPromise;
        } finally {
            // Remove from running tasks
            this.runningTasks.delete(taskName);
        }
    }

    /**
     * Execute the task with proper state management.
     * @param {string} taskName
     * @param {string} mode
     * @param {import('../types').Callback} callback
     * @returns {Promise<void>}
     */
    async executeTask(taskName, mode, callback) {
        const runId = newRunId();
        const startTime = now();

        // Mark task as running and set attempt time
        await this.store.transaction(async (txn) => {
            const state = await txn.getState();
            const task = state.tasks.find(t => {
                return taskIdToString(t.name) === taskName;
            });

            if (task) {
                task.isRunning = true;
                task.lastAttemptTime = startTime;
                await txn.setState(state);
            }
        });

        logTaskStarted(taskName, runId, mode, startTime, this.logger);

        try {
            // Execute the callback
            await callback();

            const endTime = now();
            const duration = endTime.epochMs - startTime.epochMs;

            // Mark success and clear retry state
            await this.store.transaction(async (txn) => {
                const state = await txn.getState();
                const task = state.tasks.find(t => {
                    return taskIdToString(t.name) === taskName;
                });

                if (task) {
                    task.isRunning = false;
                    task.lastSuccessTime = endTime;
                    task.pendingRetryUntil = null;
                    
                    // For cron mode, update lastEvaluatedFire to the start time
                    // This represents when the task was evaluated for cron schedule
                    if (mode === 'cron') {
                        task.lastEvaluatedFire = startTime;
                    }
                    
                    await txn.setState(state);
                }
            });

            logTaskSucceeded(taskName, runId, mode, duration, endTime, this.logger);

        } catch (error) {
            const endTime = now();
            const duration = endTime.epochMs - startTime.epochMs;
            const errorMessage = error instanceof Error ? error.message : String(error);

            // Mark failure and schedule retry
            await this.store.transaction(async (txn) => {
                const state = await txn.getState();
                const task = state.tasks.find(t => {
                    return taskIdToString(t.name) === taskName;
                });

                if (task) {
                    task.isRunning = false;
                    task.lastFailureTime = endTime;
                    
                    // Calculate retry time
                    const retryTime = calculateRetryTime(endTime, task.retryDelay);
                    task.pendingRetryUntil = retryTime;
                    
                    await txn.setState(state);
                    
                    // Log retry scheduling
                    logRetryScheduled(
                        taskName, 
                        runId, 
                        retryTime, 
                        task.retryDelay.toMs(), 
                        endTime, 
                        this.logger
                    );
                }
            });

            logTaskFailed(taskName, runId, mode, errorMessage, duration, endTime, this.logger);
        }
    }

    /**
     * Check if a task is currently running.
     * @param {string} taskName
     * @returns {boolean}
     */
    isRunning(taskName) {
        return this.runningTasks.has(taskName);
    }

    /**
     * Get count of running tasks.
     * @returns {number}
     */
    getRunningCount() {
        return this.runningTasks.size;
    }

    /**
     * Stop all running tasks (best effort).
     * @returns {Promise<void>}
     */
    async stop() {
        // We can't really stop running callbacks, but we can clear our tracking
        this.runningTasks.clear();
    }
}

/**
 * Create an executor instance.
 * @param {import('../types').Store} store
 * @param {import('../../logger').Logger} logger
 * @returns {Executor}
 */
function createExecutor(store, logger) {
    return new Executor(store, logger);
}

module.exports = {
    createExecutor,
    Executor,
};