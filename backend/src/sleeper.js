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
 * @property {<T>(key: UniqueTerm, mode: string, procedure: () => Promise<T>) => Promise<T>} withModeMutex - Execute a procedure while holding a mode lock. Same-mode callers for the same key may run concurrently; different modes are exclusive.
 */

/**
 * @typedef {{ promise: Promise<void>, releaseRef: { fn: () => void } }} MutexEntry
 */

/**
 * @typedef {{ mode: string, resolve: (value?: void) => void }} ModeMutexWaiter
 */

/**
 * @typedef {{ activeMode: string | undefined, activeCount: number, queue: Array<ModeMutexWaiter> }} ModeMutexEntry
 */

function make() {

    /** @type {Map<string, MutexEntry>} */
    const mutexes = new Map();
    /** @type {Map<string, ModeMutexEntry>} */
    const modeMutexes = new Map();

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
     * @template T
     * @param {UniqueTerm} key
     * @param {string} mode
     * @param {() => Promise<T>} procedure
     * @returns {Promise<T>}
     */
    async function withModeMutex(key, mode, procedure) {
        const stringKey = key.serialize();
        let entry = modeMutexes.get(stringKey);
        if (entry === undefined) {
            entry = {
                activeMode: undefined,
                activeCount: 0,
                queue: [],
            };
            modeMutexes.set(stringKey, entry);
        }

        const canEnterImmediately =
            entry.queue.length === 0 &&
            (
                entry.activeCount === 0 ||
                entry.activeMode === mode
            );

        if (canEnterImmediately) {
            entry.activeMode = mode;
            entry.activeCount += 1;
        } else {
            const waitingEntry = entry;
            await new Promise((resolve) => {
                waitingEntry.queue.push({ mode, resolve });
            });
            entry = modeMutexes.get(stringKey);
            if (entry === undefined) {
                throw new Error(
                    `withModeMutex: internal state corruption detected for key "${stringKey}" after waiting`
                );
            }
        }
        const activeEntry = entry;

        try {
            return await procedure();
        } finally {
            activeEntry.activeCount -= 1;
            if (activeEntry.activeCount === 0) {
                activeEntry.activeMode = undefined;
                if (activeEntry.queue.length === 0) {
                    modeMutexes.delete(stringKey);
                } else {
                    const firstWaiter = activeEntry.queue.shift();
                    if (firstWaiter === undefined) {
                        modeMutexes.delete(stringKey);
                    } else {
                        const nextMode = firstWaiter.mode;
                        activeEntry.activeMode = nextMode;
                        activeEntry.activeCount += 1;
                        firstWaiter.resolve();
                        while (activeEntry.queue[0]?.mode === nextMode) {
                            const waiter = activeEntry.queue.shift();
                            if (waiter === undefined) {
                                break;
                            }
                            activeEntry.activeCount += 1;
                            waiter.resolve();
                        }
                    }
                }
            }
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

    return { sleep, makeSleeper, withMutex, withModeMutex };
}

module.exports = {
    make,
};
