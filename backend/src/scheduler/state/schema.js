// @ts-check
/**
 * Schema definitions for scheduler state.
 */

const { CURRENT_STATE_VERSION } = require('../constants');

/**
 * Validate scheduler state schema.
 * @param {any} state
 * @returns {import('../types').SchedulerState}
 * @throws {Error} If state is invalid
 */
function validateState(state) {
    if (!state || typeof state !== 'object') {
        throw new Error("State must be an object");
    }

    if (typeof state.version !== 'string') {
        throw new Error("State version must be a string");
    }

    if (state.version !== CURRENT_STATE_VERSION) {
        throw new Error(`Unsupported state version: ${state.version}`);
    }

    if (!Array.isArray(state.tasks)) {
        throw new Error("State tasks must be an array");
    }

    for (let i = 0; i < state.tasks.length; i++) {
        try {
            validateTask(state.tasks[i]);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid task at index ${i}: ${message}`);
        }
    }

    if (!state.lastUpdated || typeof state.lastUpdated.epochMs !== 'number') {
        throw new Error("State lastUpdated must be an InstantMs");
    }

    return state;
}

/**
 * Validate task object.
 * @param {any} task
 * @throws {Error} If task is invalid
 */
function validateTask(task) {
    if (!task || typeof task !== 'object') {
        throw new Error("Task must be an object");
    }

    const requiredFields = ['name', 'cron', 'retryDelay'];
    for (const field of requiredFields) {
        if (!(field in task)) {
            throw new Error(`Missing required field: ${field}`);
        }
    }

    // Additional type validation would go here
    // For now, we trust the value objects to validate themselves
}

/**
 * Create default state.
 * @returns {import('../types').SchedulerState}
 */
function createDefaultState() {
    const { now } = require('../time/clock');
    
    return {
        version: CURRENT_STATE_VERSION,
        tasks: [],
        lastUpdated: now(),
    };
}

/**
 * Check if state needs migration.
 * @param {any} state
 * @returns {boolean}
 */
function needsMigration(state) {
    return state && state.version !== CURRENT_STATE_VERSION;
}

/**
 * Migrate state to current version.
 * @param {any} oldState
 * @returns {import('../types').SchedulerState}
 */
function migrateState(oldState) {
    if (!needsMigration(oldState)) {
        return oldState;
    }

    // For now, we don't support migration
    // In the future, migration logic would go here
    throw new Error(`State migration from version ${oldState.version} to ${CURRENT_STATE_VERSION} is not supported`);
}

module.exports = {
    validateState,
    validateTask,
    createDefaultState,
    needsMigration,
    migrateState,
};