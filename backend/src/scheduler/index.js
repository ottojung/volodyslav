// @ts-check
/**
 * Public surface for the scheduler.
 * Wires together registry → state → planner → poller → executor.
 */

/** @typedef {import('./types').Registration} Registration */

/** @type {((capabilities: import('../capabilities/root').Capabilities, registrations: Array<Registration>) => Promise<void>) | null} */
let globalInitialize = null;

/** @type {(() => Promise<void>) | null} */
let globalStop = null;

/**
 * Initialize the scheduler with task registrations.
 * @param {import('../capabilities/root').Capabilities} capabilities
 * @param {Array<Registration>} registrations
 * @returns {Promise<void>}
 */
async function initialize(capabilities, registrations) {
    if (globalInitialize) {
        return await globalInitialize(capabilities, registrations);
    }
    throw new Error("Scheduler not created. Call make() first.");
}

/**
 * Stop the scheduler and clean up resources.
 * @type {() => Promise<void>}
 */
async function stop() {
    if (globalStop) {
        return await globalStop();
    }
    throw new Error("Scheduler not created. Call make() first.");
}

/**
 * Create a scheduler instance.
 * @param {() => import('../capabilities/root').Capabilities} getCapabilities
 * @returns {import('./types').Scheduler}
 */
function make(getCapabilities) {
    const { DEFAULT_POLL_INTERVAL_MS } = require('./constants');
    const { fromMs } = require('./value-objects/poll-interval');
    const { buildRegistry, validateAgainstPersistedState, persistDefinitions } = require('./registry/registry');
    const { createStore } = require('./state/store');
    const { createExecutor } = require('./runtime/executor');
    const { createPoller } = require('./runtime/poller');
    const { logStartupValidated } = require('./observability/logging');
    const { now } = require('./time/clock');

    /** @type {any} */
    let poller = null;
    /** @type {any} */
    let registry = null;

    /**
     * Initialize the scheduler with the given registrations.
     * @param {Array<Registration>} registrations
     * @returns {Promise<void>}
     */
    async function initializeImpl(registrations) {
        const caps = getCapabilities();

        // Build and validate registry
        registry = buildRegistry(registrations);

        // Create state store
        const store = createStore(caps.state);

        // Check if this is first-time initialization and validate if not
        let isFirstTime = false;
        try {
            await store.transaction(async (txn) => {
                const state = await txn.getState();
                
                if (state.tasks.length === 0) {
                    isFirstTime = true;
                    caps.logger.logInfo(
                        {
                            registeredTaskCount: registrations.length,
                            taskNames: registrations.map(([name]) => name)
                        },
                        "First-time scheduler initialization: registering initial tasks"
                    );
                } else {
                    // Validate registrations match persisted state - this will throw if mismatch
                    caps.logger.logDebug(
                        {
                            persistedTaskCount: state.tasks.length,
                            registrationCount: registrations.length
                        },
                        "Validating task registrations against persisted state"
                    );
                    validateAgainstPersistedState(registry, state.tasks);
                }
            });
        } catch (error) {
            // If it's a validation error, re-throw it
            const { isStartupDriftError } = require('./errors');
            if (isStartupDriftError(error)) {
                throw error;
            }
            // If we can't read state for other reasons, treat as first time
            isFirstTime = true;
        }

        // Persist definitions if first time
        if (isFirstTime) {
            await persistDefinitions(registry, store);
        }

        // Handle poller lifecycle
        if (poller !== null) {
            // Scheduler already running
            caps.logger.logDebug(
                {},
                "Scheduler already initialized"
            );
            return;
        }

        // Create and start poller
        const pollInterval = fromMs(DEFAULT_POLL_INTERVAL_MS);
        const executor = createExecutor(store, caps.logger);
        poller = createPoller(store, executor, caps.logger, registry, pollInterval);

        // Start polling
        poller.start();

        // Log successful startup
        const taskNames = registry.getTaskNames();
        logStartupValidated(taskNames.length, taskNames, now(), caps.logger);
    }

    /**
     * Stop the scheduler and clean up resources.
     * @type {() => Promise<void>}
     */
    async function stopImpl() {
        if (poller !== null) {
            poller.stop();
            poller = null;
        }
    }

    // Set global functions with adapters for the module-level API
    globalInitialize = (_capabilities, registrations) => initializeImpl(registrations);
    globalStop = stopImpl;

    return {
        initialize: initializeImpl,
        stop: stopImpl,
    };
}

/**
 * Validate a cron expression without creating a scheduler.
 * @param {string} cronExpression
 * @returns {boolean}
 */
function validate(cronExpression) {
    const { isValid } = require('./value-objects/cron-expression/validate');
    return isValid(cronExpression);
}

// Re-export types for external consumption
/** @typedef {import('./types').Scheduler} Scheduler */
/** @typedef {import('./types').TaskIdentity} TaskIdentity */
/** @typedef {import('./types').Initialize} Initialize */
/** @typedef {import('./types').Stop} Stop */

module.exports = {
    make,
    initialize,
    stop,
    validate,
    // Legacy compatibility exports
    isTaskListMismatchError: require('./errors').isStartupDriftError,
    ScheduleInvalidNameError: require('./errors').InvalidCronError,
    ScheduleDuplicateTaskError: require('./errors').DuplicateTaskError,
    isScheduleDuplicateTaskError: require('./errors').isDuplicateTaskError,
    parseCronExpression: require('./value-objects/cron-expression').fromString,
    getNextExecution: (/** @type {import('./value-objects/cron-expression').CronExpression} */ cron, /** @type {import('./value-objects/instant').InstantMs} */ fromTime) => cron.nextAfter(fromTime),
    isCronExpression: require('./value-objects/cron-expression').isCronExpression,
    isInvalidCronExpressionError: require('./errors').isInvalidCronError,
    InvalidCronExpressionError: require('./errors').InvalidCronError,
};