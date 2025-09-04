/**
 * Sleeper capability for pausing execution.
 */

const { fromObject } = require('./datetime/duration');

/**
 * @typedef {object} Sleeper
 * @property {(duration: import('luxon').Duration) => Promise<void>} sleep - Pause for the given duration.
 * @property {<T>(name: string, procedure: () => Promise<T>) => Promise<T>} withMutex - Execute a procedure with a mutex lock.
 */

/**
 * Pauses execution for the specified duration.
 * @param {import('luxon').Duration} duration - Duration to sleep.
 * @returns {Promise<void>} Resolves after the delay.
 */
function sleep(duration) {
    return new Promise((resolve) => {
        setTimeout(resolve, duration.toMillis());
    });
}

function make() {

    /** @type {Set<string>} */
    const mutexes = new Set();

    /**
     * @template T
     * @param {string} name
     * @param {() => Promise<T>} procedure
     * @returns {Promise<T>}
     */
    async function withMutex(name, procedure) {
        while (mutexes.has(name)) {
            const shortDelay = fromObject({milliseconds: 1});
            await new Promise(resolve => setTimeout(resolve, shortDelay.toMillis()));
        }

        mutexes.add(name);
        try {
            return await procedure();
        } finally {
            mutexes.delete(name);
        }
    }

    return { sleep, withMutex };
}

module.exports = {
    make,
};
