// @ts-check
/**
 * Registry for managing task registrations.
 */

/**
 * Registry for task definitions.
 */
class Registry {
    /** @type {Map<string, import('../types').ParsedRegistration>} */
    tasks;

    constructor() {
        this.tasks = new Map();
    }

    /**
     * Register a task.
     * @param {import('../types').ParsedRegistration} registration
     * @throws {Error} If task already exists
     */
    register(registration) {
        const { toString } = require('../value-objects/task-id');
        const { DuplicateTaskError } = require('../errors');
        
        const taskName = toString(registration.name);
        
        if (this.tasks.has(taskName)) {
            throw new DuplicateTaskError(taskName);
        }
        
        this.tasks.set(taskName, registration);
    }

    /**
     * Get a registered task.
     * @param {string} taskName
     * @returns {import('../types').ParsedRegistration | undefined}
     */
    get(taskName) {
        return this.tasks.get(taskName);
    }

    /**
     * Get all registered task names.
     * @returns {string[]}
     */
    getTaskNames() {
        return Array.from(this.tasks.keys()).sort();
    }

    /**
     * Get all registered tasks.
     * @returns {Array<import('../types').ParsedRegistration>}
     */
    getAllTasks() {
        return Array.from(this.tasks.values());
    }

    /**
     * Check if a task is registered.
     * @param {string} taskName
     * @returns {boolean}
     */
    has(taskName) {
        return this.tasks.has(taskName);
    }

    /**
     * Get the number of registered tasks.
     * @returns {number}
     */
    size() {
        return this.tasks.size;
    }

    /**
     * Clear all registrations.
     */
    clear() {
        this.tasks.clear();
    }
}

/**
 * Build registry from registrations.
 * @param {Array<import('../types').Registration>} registrations
 * @returns {Registry}
 */
function buildRegistry(registrations) {
    const { validateRegistrations } = require('./validator');
    
    // Validate all registrations first
    const parsedRegistrations = validateRegistrations(registrations);
    
    // Build registry
    const registry = new Registry();
    
    for (const parsed of parsedRegistrations) {
        registry.register(parsed);
    }
    
    return registry;
}

/**
 * Compare registry with persisted state.
 * @param {Registry} registry
 * @param {Array<import('../types').TaskDefinition & import('../types').TaskRuntime>} persistedTasks
 * @throws {Error} If there are mismatches
 */
function validateAgainstPersistedState(registry, persistedTasks) {
    const { compareSignatures } = require('./signature');
    const { StartupDriftError } = require('../errors');
    
    const registrySignature = createRegistrySignature(registry);
    const persistedSignature = createPersistedSignature(persistedTasks);
    
    const comparison = compareSignatures(registrySignature, persistedSignature);
    
    if (comparison.hasDifferences) {
        throw new StartupDriftError(
            `Task configuration drift detected: ${comparison.summary}`,
            comparison.details
        );
    }
}

/**
 * Create signature from registry.
 * @param {Registry} registry
 * @returns {object}
 */
function createRegistrySignature(registry) {
    const { createSignature } = require('./signature');
    const tasks = registry.getAllTasks().map(task => ({
        name: task.name,
        cron: task.cron,
        retryDelay: task.retryDelay,
    }));
    return createSignature(tasks);
}

/**
 * Create signature from persisted tasks.
 * @param {Array<import('../types').TaskDefinition & import('../types').TaskRuntime>} tasks
 * @returns {object}
 */
function createPersistedSignature(tasks) {
    const { createSignature } = require('./signature');
    const taskDefs = tasks.map(task => ({
        name: task.name,
        cron: task.cron,
        retryDelay: task.retryDelay,
    }));
    return createSignature(taskDefs);
}

/**
 * Persist registry definitions to state.
 * @param {Registry} registry
 * @param {import('../types').Store} store
 * @returns {Promise<void>}
 */
async function persistDefinitions(registry, store) {
    const { now } = require('../time/clock');
    const { createDefaultState } = require('../state/schema');
    
    await store.transaction(async (txn) => {
        let state;
        
        try {
            state = await txn.getState();
        } catch {
            // Create new state if none exists
            state = createDefaultState();
        }
        
        // Convert registry to task definitions
        const tasks = registry.getAllTasks().map(task => ({
            name: task.name,
            cron: task.cron,
            retryDelay: task.retryDelay,
            lastSuccessTime: null,
            lastFailureTime: null,
            lastAttemptTime: null,
            pendingRetryUntil: null,
            lastEvaluatedFire: null,
            isRunning: false,
        }));
        
        state.tasks = tasks;
        state.lastUpdated = now();
        
        await txn.setState(state);
    });
}

module.exports = {
    Registry,
    buildRegistry,
    validateAgainstPersistedState,
    persistDefinitions,
};