/**
 * SleepCapability capability for pausing execution.
 */

const { fromMilliseconds } = require('./datetime/duration');

/** @typedef {import('./datetime').Duration} Duration */

/**
 * @typedef {object} Sleeper
 * @property {(duration: Duration) => Promise<void>} sleep - Pause for the given duration.
 * @property {() => void} wake - Wake up from sleep prematurely.
 */

/**
 * @typedef {object} SleepCapability
 * @property {(name: string, duration: Duration) => Promise<void>} sleep - Pause for the given duration.
 * @property {(name: string) => Sleeper} makeSleeper - Create a sleeper instance with its own wake method.
 * @property {<T>(name: string, procedure: () => Promise<T>) => Promise<T>} withMutex - Execute a procedure with a mutex lock.
 */

function make() {

    /** @type {Set<string>} */
    const mutexes = new Set();

    const shortDelayMs = fromMilliseconds(1).toMillis();

    /**
     * @template T
     * @param {string} name
     * @param {() => Promise<T>} procedure
     * @returns {Promise<T>}
     */
    async function withMutex(name, procedure) {
        while (mutexes.has(name)) {
            await new Promise(resolve => setTimeout(resolve, shortDelayMs));
        }

        mutexes.add(name);
        try {
            return await procedure();
        } finally {
            mutexes.delete(name);
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

    return { sleep, makeSleeper, withMutex };
}

module.exports = {
    make,
};
