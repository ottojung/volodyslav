/**
 * SleepCapability capability for pausing execution.
 */

/** @typedef {import('./datetime').Duration} Duration */
/** @typedef {import('./unique_functor').UniqueTerm} UniqueTerm */

/**
 * @typedef {object} Sleeper
 * @property {(duration: Duration) => Promise<void>} sleep - Pause for the given duration.
 * @property {() => void} wake - Wake up from sleep prematurely.
 */

/**
 * @typedef {object} SleepCapability
 * @property {(name: string, duration: Duration) => Promise<void>} sleep - Pause for the given duration.
 * @property {(name: string) => Sleeper} makeSleeper - Create a sleeper instance with its own wake method.
 * @property {<T>(key: UniqueTerm, procedure: () => Promise<T>) => Promise<T>} withMutex - Execute a procedure with a mutex lock.
 * @property {<T>(key: UniqueTerm, procedure: () => Promise<T>) => Promise<T>} withoutMutex - Temporarily release a held mutex, run a procedure, then re-acquire. Must be called from within a withMutex callback for the same key.
 */

/**
 * @typedef {{ promise: Promise<void>, releaseRef: { fn: () => void } }} MutexEntry
 */

function make() {

    /** @type {Map<string, MutexEntry>} */
    const mutexes = new Map();

    /**
     * @template T
     * @param {UniqueTerm} key - The unique key for the mutex. This should be a UniqueTerm instance to ensure uniqueness across the application.
     * @param {() => Promise<T>} procedure
     * @returns {Promise<T>}
     */
    async function withMutex(key, procedure) {
        const stringKey = key.serialize();
        for (;;) {
            const existing = mutexes.get(stringKey);
            if (existing === undefined) {
                break;
            }
            await existing.promise;
        }

        /** @type {{ fn: () => void }} */
        const releaseRef = { fn: () => undefined };

        const promise = new Promise((resolve) => {
            releaseRef.fn = () => resolve(undefined);
        });
        mutexes.set(stringKey, { promise, releaseRef });

        try {
            return await procedure();
        } finally {
            mutexes.delete(stringKey);
            releaseRef.fn();
        }
    }

    /**
     * Temporarily releases a mutex that is currently held, runs a procedure
     * without the mutex, then re-acquires it before returning.
     *
     * This MUST be called from within a `withMutex` callback for the same key.
     * Calling it when the mutex is not held throws immediately.
     *
     * The mutex is always re-acquired before any result or error propagates to
     * the caller, even if the procedure throws.
     *
     * @template T
     * @param {UniqueTerm} key - The mutex key, matching the enclosing withMutex call.
     * @param {() => Promise<T>} procedure - The procedure to run without the mutex.
     * @returns {Promise<T>}
     */
    async function withoutMutex(key, procedure) {
        const stringKey = key.serialize();
        const entry = mutexes.get(stringKey);

        if (entry === undefined) {
            throw new Error(
                `withoutMutex: mutex is not currently held for key "${stringKey}". ` +
                `withoutMutex must be called from within a withMutex callback.`
            );
        }

        const { releaseRef } = entry;

        // Temporarily release the mutex so other waiters can proceed.
        mutexes.delete(stringKey);
        releaseRef.fn();

        try {
            return await procedure();
        } finally {
            // Re-acquire the mutex, waiting like any new withMutex caller would.
            for (;;) {
                const existing = mutexes.get(stringKey);
                if (existing === undefined) {
                    break;
                }
                await existing.promise;
            }

            // Create a new lock promise and update releaseRef so the outer
            // withMutex finally block releases this new lock (not the original).
            const promise = new Promise((resolve) => {
                releaseRef.fn = () => resolve(undefined);
            });
            mutexes.set(stringKey, { promise, releaseRef });
        }
    }

    /**
     * Pauses execution for the specified duration.
     * @param {string} _name - Name for the sleep operation.
     * @param {Duration} duration - Duration to sleep.
     * @returns {Promise<void>} Resolves after the delay.
     */
    function sleep(_name, duration) {
        return new Promise((resolve) => setTimeout(resolve, duration.toMillis()));
    }

    /**
     * Clears any pending sleeps with the given name.
     * @param {string} _name
     * @returns {Sleeper}
     */
    function makeSleeper(_name) {
        /** @type {NodeJS.Timeout | undefined} */
        let timeout = undefined;
        /** @type {undefined | ((value: unknown) => void)} */
        let savedResolve = undefined;

        /**
         * @param {Duration} duration
         */
        async function sleep(duration) {
            await new Promise((resolve) => {
                savedResolve = resolve;
                timeout = setTimeout(resolve, duration.toMillis());
            });
        }

        function wake() {
            clearTimeout(timeout);
            savedResolve?.(0);
        }

        return { sleep, wake };
    }

    return { sleep, makeSleeper, withMutex, withoutMutex };
}

module.exports = {
    make,
};
