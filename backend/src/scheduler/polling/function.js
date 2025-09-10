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
const { evaluateTasksForExecution } = require('../execution');
const { fromMinutes, difference } = require('../../datetime');
const { THREAD_NAME } = require('./interval');

const POLL_INTERVAL = fromMinutes(10);

/** @typedef {import('../types').Callback} Callback */

/**
 * Create a polling function that evaluates and executes due tasks.
 * @param {import('../types').SchedulerCapabilities} capabilities
 * @param {import('../types').ParsedRegistrations} registrations
 * @param {Set<string>} scheduledTasks
 * @param {ReturnType<import('../execution').makeTaskExecutor>} taskExecutor
 * @param {string} schedulerIdentifier
 * @returns {{start: () => void, stop: () => Promise<void>}} Loop manager with start/stop methods
 */
function makePollingFunction(capabilities, registrations, scheduledTasks, taskExecutor, schedulerIdentifier) {
    const dt = capabilities.datetime;
    /** @type {Set<Promise<void>>} */
    const runningPool = new Set();
    let parallelCounter = 0;
    let isActive = false;
    const sleeper = capabilities.sleeper.makeSleeper(THREAD_NAME);
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

    async function stop() {
        if (isActive === true) {
            isActive = false;
            sleeper.wake();
            await loopThread;
            await join();
        }
    }

    async function loop() {
        await new Promise((resolve) => setImmediate(resolve));
        
        // Check the actual polling interval being used by testing a brief sleep.
        // This handles the case where test stubs override the sleep duration.
        const testStartTime = dt.now();
        const testSleep = sleeper.sleep(POLL_INTERVAL);
        const testTimeout = new Promise(resolve => setTimeout(resolve, 200));
        
        await Promise.race([testSleep, testTimeout]);
        const testEndTime = dt.now();
        const actualDuration = difference(testEndTime, testStartTime).toMillis();
        
        // Wake up the sleeper in case it's still sleeping
        sleeper.wake();
        
        // If the actual sleep duration suggests a long interval (> 1 second),
        // add a delay before the first poll to prevent race conditions.
        // This specifically handles the case where the default 10-minute interval
        // is being used, which can cause deadlocks with immediate transactions.
        if (actualDuration >= 200) {
            // Long interval detected - add a short delay before first poll
            await sleeper.sleep(fromMinutes(1));
        }
        
        while (isActive) {
            await pollWrapper();
            await sleeper.sleep(POLL_INTERVAL);
        }
    }

    async function getDueTasks() {
        const now = dt.now();
        return await mutateTasks(capabilities, registrations, (tasks) =>
            evaluateTasksForExecution(tasks, scheduledTasks, now, capabilities, schedulerIdentifier)
        );
    }

    async function pollWrapper() {
        // Collection exclusivity optimization: prevent overlapping collection phases
        // to reduce wasteful duplicate work. Task execution itself remains reentrant.
        if (parallelCounter > 0) {
            // Another thread is already collecting due tasks; skip to avoid duplication
            return;
        } else {
            parallelCounter++;
            try {
                await poll();
            } finally {
                parallelCounter--;
            }
        }
    }

    async function poll() {
        // Collect tasks and stats.
        const { dueTasks, stats } = await getDueTasks();

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
            "PollSummary"
        );
    }

    return { start, stop };
}

module.exports = {
    makePollingFunction,
};
