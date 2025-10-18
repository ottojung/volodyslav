/**
 * Polling execution logic.
 * Handles the core polling behavior with collection exclusivity optimization.
 * 
 * IMPORTANT: The polling loop is intentionally reentrant for task execution.
 * This reentrancy is essential because long-running tasks must not block newly 
 * due tasks from being executed. Task execution happens in parallel to ensure
 * the scheduler remains responsive regardless of individual task duration.
 * 
 * The only exclusivity protection is during the collection phase: when a thread
 * starts collecting due tasks and sees another thread is already collecting
 * (via parallelCounter), it exits early. This optimization reduces wasteful
 * duplicate collection work, not reentrancy itself.
 */

const { mutateTasks } = require('../persistence');
const { evaluateTasksForExecution, calculateNextDueTime } = require('../execution');

/** @typedef {import('../types').Callback} Callback */

/**
 * Create a polling function that evaluates and executes due tasks.
 * @param {import('../types').SchedulerCapabilities} capabilities
 * @param {import('../types').ParsedRegistrations} registrations
 * @param {Set<string>} scheduledTasks
 * @param {ReturnType<import('../execution').makeTaskExecutor>} taskExecutor
 * @param {string} schedulerIdentifier
 * @param {import('../../sleeper').Sleeper} sleeper
 * @returns {{start: () => void, stop: () => Promise<void>}} Loop manager with start/stop methods
 */
function makePollingFunction(capabilities, registrations, scheduledTasks, taskExecutor, schedulerIdentifier, sleeper) {
    const dt = capabilities.datetime;
    /** @type {Set<Promise<void>>} */
    const runningPool = new Set();
    let parallelCounter = 0;
    let isActive = false;
    /** @type {Promise<void> | null} */
    let stoppingThread = null;
    /** @type {Promise<void> | null} */
    let loopThread = null;

    /**
     * Wrap a promise to ensure it is removed from the running pool when done
     * @param {Promise<void>} promise
     */
    function wrap(promise) {
        const wrapped = promise.finally(() => {
            runningPool.delete(wrapped);
        });
        return wrapped;
    }

    /**
     * Wait for all currently running tasks to complete
     * @returns {Promise<void>}
     */
    async function join() {
        await Promise.all([...runningPool]);
    }

    function start() {
        if (isActive === false) {
            isActive = true;
            loopThread = loop();
        }
    }

    async function actualStop() {
        if (isActive === true) {
            isActive = false;
            sleeper.wake();
            await loopThread;
            await join();
        }
    }

    async function stop() {
        if (stoppingThread === null) {
            if (isActive === false) {
                // Already stopped; nothing to do
                return;
            }
            stoppingThread = actualStop().finally(() => {
                stoppingThread = null;
            });
        }
        return await stoppingThread;
    }

    async function loop() {
        await new Promise((resolve) => setImmediate(resolve));
        while (isActive) {
            const sleepDuration = await pollWrapper();
            if (isActive && sleepDuration) {
                await sleeper.sleep(sleepDuration);
            }
        }
    }

    async function getDueTasksAndNextSleepDuration() {
        const now = dt.now();
        return await mutateTasks(capabilities, registrations, (tasks) => {
            const executionResult = evaluateTasksForExecution(tasks, scheduledTasks, now, capabilities, schedulerIdentifier);
            const sleepDuration = calculateNextDueTime(tasks, scheduledTasks, now, capabilities);
            return { ...executionResult, sleepDuration };
        });
    }

    async function pollWrapper() {
        // Collection exclusivity optimization: prevent overlapping collection phases
        // to reduce wasteful duplicate work. Task execution itself remains reentrant.
        if (parallelCounter > 0) {
            // Another thread is already collecting due tasks; skip to avoid duplication
            return undefined;
        } else {
            parallelCounter++;
            try {
                return await poll();
            } finally {
                parallelCounter--;
            }
        }
    }

    async function poll() {
        // Collect tasks, stats, and next sleep duration in a single transaction
        const { dueTasks, stats, sleepDuration } = await getDueTasksAndNextSleepDuration();
        if (isActive === false) {
            // Stopped while collecting; do not execute any tasks.
            // Some tasks may have been marked as "running" but that's okay.
            return undefined;
        }

        // Execute all due tasks in parallel
        const todo = taskExecutor.executeTasks(dueTasks);
        runningPool.add(wrap(todo));

        capabilities.logger.logDebug(
            {
                due: dueTasks.length,
                dueRetry: stats.dueRetry,
                dueCron: stats.dueCron,
                skippedRunning: stats.skippedRunning,
                skippedRetryFuture: stats.skippedRetryFuture,
                skippedNotDue: stats.skippedNotDue,
            },
            "Executed polling cycle",
        );

        return sleepDuration;
    }

    return { start, stop };
}

module.exports = {
    makePollingFunction,
};
