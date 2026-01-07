/**
 * Simple async mutex implementation for concurrency control.
 * Ensures that only one async operation can execute at a time within a critical section.
 * Based on the pattern from sleeper.js withMutex implementation.
 */

const memconst = require('../../memconst');

/**
 * @template T
 * @typedef {() => Promise<T>} AsyncFunction
 */

/**
 * @typedef {object} Mutex
 * @property {<T>(fn: AsyncFunction<T>) => Promise<T>} runExclusive - Execute a function exclusively, waiting for any previous calls to complete
 */

class MutexClass {
    /**
     * Map storing the currently executing operation promise.
     * @private
     * @type {Map<string, () => Promise<unknown>>}
     */
    mutexMap;

    /**
     * The single mutex key used for all operations.
     * @private
     * @type {string}
     */
    static MUTEX_KEY = 'default';

    constructor() {
        this.mutexMap = new Map();
    }

    /**
     * Execute a function exclusively.
     * If another function is already executing, wait for it to complete first.
     * Uses the same pattern as sleeper.js withMutex.
     * @template T
     * @param {AsyncFunction<T>} fn - The async function to execute
     * @returns {Promise<T>} - The result of the function
     */
    async runExclusive(fn) {
        const key = MutexClass.MUTEX_KEY;
        
        // Wait for any existing operation to complete
        for (;;) {
            const existing = this.mutexMap.get(key);
            if (existing === undefined) {
                break;
            } else {
                await existing();
            }
        }

        // Create a memoized wrapper for this operation
        const wrapped = memconst(async () => {
            this.mutexMap.set(key, wrapped);
            try {
                return await fn();
            } finally {
                this.mutexMap.delete(key);
            }
        });
        
        return await wrapped();
    }
}

/**
 * Factory function to create a Mutex instance.
 * @returns {Mutex}
 */
function makeMutex() {
    return new MutexClass();
}

/**
 * Type guard for Mutex.
 * @param {unknown} object
 * @returns {object is MutexClass}
 */
function isMutex(object) {
    return object instanceof MutexClass;
}

module.exports = {
    makeMutex,
    isMutex,
};
