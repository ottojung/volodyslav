/**
 * Simple async mutex implementation for concurrency control.
 * Ensures that only one async operation can execute at a time within a critical section.
 */

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
     * Promise that resolves when the current holder releases the lock.
     * Undefined when the lock is free.
     * @private
     * @type {Promise<void> | undefined}
     */
    currentPromise;

    constructor() {
        this.currentPromise = undefined;
    }

    /**
     * Execute a function exclusively.
     * If another function is already executing, wait for it to complete first.
     * @template T
     * @param {AsyncFunction<T>} fn - The async function to execute
     * @returns {Promise<T>} - The result of the function
     */
    async runExclusive(fn) {
        // Wait for any existing operation to complete
        while (this.currentPromise !== undefined) {
            await this.currentPromise;
        }

        // Create a new promise for this operation
        let resolve;
        this.currentPromise = new Promise((r) => {
            resolve = r;
        });

        try {
            // Execute the function
            return await fn();
        } finally {
            // Release the lock
            this.currentPromise = undefined;
            if (resolve) {
                resolve();
            }
        }
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
