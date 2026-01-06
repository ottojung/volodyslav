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
     * Queue of pending operations.
     * Each entry is a function that resolves when it's this operation's turn.
     * @private
     * @type {Array<() => void>}
     */
    queue;

    /**
     * Whether an operation is currently executing.
     * @private
     * @type {boolean}
     */
    locked;

    constructor() {
        this.queue = [];
        this.locked = false;
    }

    /**
     * Execute a function exclusively.
     * If another function is already executing, wait for it to complete first.
     * @template T
     * @param {AsyncFunction<T>} fn - The async function to execute
     * @returns {Promise<T>} - The result of the function
     */
    async runExclusive(fn) {
        // Wait for lock to be available
        if (this.locked) {
            await new Promise((resolve) => {
                this.queue.push(resolve);
            });
        }

        // Acquire lock
        this.locked = true;

        try {
            // Execute the function
            return await fn();
        } finally {
            // Release the lock and notify next waiter
            const next = this.queue.shift();
            if (next) {
                // There's a waiter, give them the lock
                next();
            } else {
                // No waiters, release the lock
                this.locked = false;
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
