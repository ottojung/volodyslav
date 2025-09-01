/**
 * Sleeper capability for pausing execution.
 */

/**
 * @typedef {object} Sleeper
 * @property {(ms: number) => Promise<void>} sleep - Pause for the given milliseconds.
 * @property {<T>(name: string, procedure: () => Promise<T>) => Promise<T>} withMutex - Execute a procedure with a mutex lock.
 */

/**
 * Pauses execution for the specified milliseconds.
 * @param {number} ms - Milliseconds to sleep.
 * @returns {Promise<void>} Resolves after the delay.
 */
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
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
            await new Promise(resolve => setTimeout(resolve, 1));
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
