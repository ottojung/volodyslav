// @ts-check
/**
 * Polling scheduler that coordinates task execution.
 */

/**
 * Poller that runs tasks based on schedule.
 */
class Poller {
    /** @type {import('../types').Store} */
    store;

    /** @type {import('./executor').Executor} */
    executor;

    /** @type {import('../../logger').Logger} */
    logger;

    /** @type {import('../registry/registry').Registry} */
    registry;

    /** @type {import('../types').PollIntervalMs} */
    pollInterval;

    /** @type {NodeJS.Timeout | null} */
    timer;

    /** @type {boolean} */
    isPolling;

    /**
     * @param {import('../types').Store} store
     * @param {import('./executor').Executor} executor
     * @param {import('../../logger').Logger} logger
     * @param {import('../registry/registry').Registry} registry
     * @param {import('../types').PollIntervalMs} pollInterval
     */
    constructor(store, executor, logger, registry, pollInterval) {
        this.store = store;
        this.executor = executor;
        this.logger = logger;
        this.registry = registry;
        this.pollInterval = pollInterval;
        this.timer = null;
        this.isPolling = false;
    }

    /**
     * Start polling.
     */
    start() {
        if (this.timer !== null) {
            return; // Already running
        }

        this.timer = setInterval(async () => {
            try {
                await this.poll();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.logError({ errorMessage: message }, `Unexpected poll error: ${message}`);
            }
        }, this.pollInterval.toMs());

        // Allow Node.js to exit gracefully if this is the only remaining timer
        this.timer.unref();
    }

    /**
     * Stop polling.
     */
    stop() {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * Perform a single poll cycle.
     * @returns {Promise<void>}
     */
    async poll() {
        // Guard against re-entrant polls
        if (this.isPolling) {
            this.logger.logDebug({ reason: "pollInProgress" }, "PollSkipped");
            return;
        }

        this.isPolling = true;
        try {
            const { now } = require('../time/clock');
            const { isEligibleNow, getExecutionMode } = require('../plan/planner');
            const { logTaskDispatched } = require('../observability/logging');

            const currentTime = now();
            let dueRetry = 0;
            let dueCron = 0;
            let skippedRunning = 0;
            let skippedNotDue = 0;

            // Get current state
            let state;
            await this.store.transaction(async (txn) => {
                state = await txn.getState();
            });

            // Collect all due tasks for execution
            const dueTasks = [];

            for (const task of state.tasks) {
                const { toString } = require('../value-objects/task-id');
                const taskName = toString(task.name);

                // Skip if task is running
                if (this.executor.isRunning(taskName)) {
                    skippedRunning++;
                    continue;
                }

                // Check if task is eligible
                const taskDef = { name: task.name, cron: task.cron, retryDelay: task.retryDelay };
                const taskRuntime = {
                    lastSuccessTime: task.lastSuccessTime,
                    lastFailureTime: task.lastFailureTime,
                    lastAttemptTime: task.lastAttemptTime,
                    pendingRetryUntil: task.pendingRetryUntil,
                    lastEvaluatedFire: task.lastEvaluatedFire,
                    isRunning: task.isRunning,
                };

                if (!isEligibleNow(taskDef, taskRuntime, currentTime)) {
                    skippedNotDue++;
                    continue;
                }

                // Determine execution mode
                const mode = getExecutionMode(taskDef, taskRuntime, currentTime);
                if (!mode) {
                    skippedNotDue++;
                    continue;
                }

                // Get callback from registry
                const registration = this.registry.get(taskName);
                if (!registration) {
                    this.logger.logError({ taskName }, "Task not found in registry");
                    continue;
                }

                const callback = registration.callback;

                dueTasks.push({
                    taskName,
                    mode,
                    callback,
                });

                if (mode === 'retry') {
                    dueRetry++;
                } else {
                    dueCron++;
                }
            }

            // Execute all due tasks
            for (const task of dueTasks) {
                const { newRunId } = require('../value-objects/run-id');
                const runId = newRunId();
                
                logTaskDispatched(task.taskName, runId, task.mode, currentTime, this.logger);
                
                // Execute task (non-blocking)
                this.executor.execute(task.taskName, task.mode, task.callback);
            }

            this.logger.logDebug(
                {
                    due: dueTasks.length,
                    dueRetry,
                    dueCron,
                    skippedRunning,
                    skippedNotDue,
                },
                "PollSummary"
            );
        } finally {
            this.isPolling = false;
        }
    }
}

/**
 * Create a poller instance.
 * @param {import('../types').Store} store
 * @param {import('./executor').Executor} executor
 * @param {import('../../logger').Logger} logger
 * @param {import('../registry/registry').Registry} registry
 * @param {import('../types').PollIntervalMs} pollInterval
 * @returns {Poller}
 */
function createPoller(store, executor, logger, registry, pollInterval) {
    return new Poller(store, executor, logger, registry, pollInterval);
}

module.exports = {
    createPoller,
    Poller,
};