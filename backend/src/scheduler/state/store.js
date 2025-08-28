// @ts-check
/**
 * Store interface for state persistence.
 */

/**
 * Store implementation that wraps the runtime state storage.
 */
class StoreImpl {
    /** @type {import('../../runtime_state_storage').RuntimeStateStorage} */
    runtimeStorage;

    /**
     * @param {import('../../runtime_state_storage').RuntimeStateStorage} runtimeStorage
     */
    constructor(runtimeStorage) {
        this.runtimeStorage = runtimeStorage;
    }

    /**
     * Execute a transaction.
     * @param {function(import('../types').StoreTxn): Promise<void>} callback
     * @returns {Promise<void>}
     */
    async transaction(callback) {
        await this.runtimeStorage.transaction(async (storage) => {
            const txn = new StoreTxnImpl(storage);
            await callback(txn);
        });
    }
}

/**
 * Store transaction implementation.
 */
class StoreTxnImpl {
    /** @type {import('../../runtime_state_storage/class').RuntimeStateStorage} */
    storage;

    /**
     * @param {import('../../runtime_state_storage/class').RuntimeStateStorage} storage
     */
    constructor(storage) {
        this.storage = storage;
    }

    /**
     * Get current scheduler state.
     * @returns {Promise<import('../types').SchedulerState>}
     */
    async getState() {
        const runtimeState = await this.storage.getExistingState();
        return convertFromRuntimeState(runtimeState);
    }

    /**
     * Set new scheduler state.
     * @param {import('../types').SchedulerState} state
     * @returns {Promise<void>}
     */
    async setState(state) {
        const runtimeState = convertToRuntimeState(state);
        this.storage.setState(runtimeState);
    }
}

/**
 * Convert runtime state to scheduler state.
 * @param {import('../../runtime_state_storage/types').RuntimeState | null} runtimeState
 * @returns {import('../types').SchedulerState}
 */
function convertFromRuntimeState(runtimeState) {
    const { CURRENT_STATE_VERSION } = require('../constants');
    const { now } = require('../time/clock');
    
    if (!runtimeState) {
        return {
            version: CURRENT_STATE_VERSION,
            tasks: [],
            lastUpdated: now(),
        };
    }

    const tasks = runtimeState.tasks.map(convertTaskRecord);
    
    return {
        version: CURRENT_STATE_VERSION,
        tasks,
        lastUpdated: now(),
    };
}

/**
 * Convert scheduler state to runtime state.
 * @param {import('../types').SchedulerState} state
 * @returns {import('../../runtime_state_storage/types').RuntimeState}
 */
function convertToRuntimeState(state) {
    const datetime = require('../../datetime');
    const dt = datetime.make();
    
    const tasks = state.tasks.map(task => convertToTaskRecord(task, dt));
    
    return {
        version: 2, // Runtime state version
        startTime: dt.fromEpochMs(state.lastUpdated.epochMs),
        tasks,
    };
}

/**
 * Convert task record to scheduler task.
 * @param {import('../../runtime_state_storage/types').TaskRecord} record
 * @returns {import('../types').TaskDefinition & import('../types').TaskRuntime}
 */
function convertTaskRecord(record) {
    const { fromString } = require('../value-objects/task-id');
    const { fromString: cronFromString } = require('../value-objects/cron-expression');
    const { fromMs } = require('../value-objects/time-duration');
    const { fromEpochMs } = require('../value-objects/instant');
    const datetime = require('../../datetime');
    const dt = datetime.make();

    return {
        name: fromString(record.name),
        cron: cronFromString(record.cronExpression),
        retryDelay: fromMs(record.retryDelayMs),
        lastSuccessTime: record.lastSuccessTime ? fromEpochMs(dt.toNativeDate(record.lastSuccessTime).getTime()) : null,
        lastFailureTime: record.lastFailureTime ? fromEpochMs(dt.toNativeDate(record.lastFailureTime).getTime()) : null,
        lastAttemptTime: record.lastAttemptTime ? fromEpochMs(dt.toNativeDate(record.lastAttemptTime).getTime()) : null,
        pendingRetryUntil: record.pendingRetryUntil ? fromEpochMs(dt.toNativeDate(record.pendingRetryUntil).getTime()) : null,
        lastEvaluatedFire: record.lastEvaluatedFire ? fromEpochMs(dt.toNativeDate(record.lastEvaluatedFire).getTime()) : null,
        isRunning: false, // Always start as not running
    };
}

/**
 * Convert scheduler task to task record.
 * @param {import('../types').TaskDefinition & import('../types').TaskRuntime} task
 * @param {import('../../datetime').Datetime} dt
 * @returns {import('../../runtime_state_storage/types').TaskRecord}
 */
function convertToTaskRecord(task, dt) {
    const { toString } = require('../value-objects/task-id');
    const { toJSON } = require('../value-objects/cron-expression/serialize');
    
    return {
        name: toString(task.name),
        cronExpression: toJSON(task.cron),
        retryDelayMs: task.retryDelay.toMs ? task.retryDelay.toMs() : task.retryDelay.toMilliseconds(),
        lastSuccessTime: task.lastSuccessTime ? dt.fromEpochMs(task.lastSuccessTime.epochMs) : undefined,
        lastFailureTime: task.lastFailureTime ? dt.fromEpochMs(task.lastFailureTime.epochMs) : undefined,
        lastAttemptTime: task.lastAttemptTime ? dt.fromEpochMs(task.lastAttemptTime.epochMs) : undefined,
        pendingRetryUntil: task.pendingRetryUntil ? dt.fromEpochMs(task.pendingRetryUntil.epochMs) : undefined,
        lastEvaluatedFire: task.lastEvaluatedFire ? dt.fromEpochMs(task.lastEvaluatedFire.epochMs) : undefined,
    };
}

/**
 * Create a store instance.
 * @param {import('../../runtime_state_storage').RuntimeStateStorage} runtimeStorage
 * @returns {import('../types').Store}
 */
function createStore(runtimeStorage) {
    return new StoreImpl(runtimeStorage);
}

module.exports = {
    createStore,
};