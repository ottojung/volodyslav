/**
 * SleepCapability capability for pausing execution.
 */

const { fromMilliseconds } = require('./datetime/duration');

/** @typedef {import('./datetime').Duration} Duration */

/**
 * @typedef {object} SleepCapability
 * @property {(name: string, duration: Duration) => Promise<void>} sleep - Pause for the given duration.
 * @property {<T>(name: string, procedure: () => Promise<T>) => Promise<T>} withMutex - Execute a procedure with a mutex lock.
 */

function make() {

    /** @type {Set<string>} */
    const mutexes = new Set();

    /** @type {Map<string, NodeJS.Timeout[]>} */
    const sleeps = new Map();

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
     * @param {string} name - Name for the sleep operation.
     * @param {Duration} duration - Duration to sleep.
     * @returns {Promise<void>} Resolves after the delay.
     */
    function sleep(name, duration) {
        return new Promise((resolve) => {
            const finish = () => {
                const existing = sleeps.get(name);
                if (existing !== undefined) {
                    if (existing.length === 1) {
                        sleeps.delete(name);
                    } else {
                        const filtered = existing.filter(t => t !== timeout);
                        sleeps.set(name, filtered);
                    }
                }
                resolve();
            };
            const timeout = setTimeout(finish, duration.toMillis());
            const existing = sleeps.get(name);
            if (existing === undefined) {
                sleeps.set(name, [timeout]);
                return;
            } else {
                existing.push(timeout);
                sleeps.set(name, existing);
            }
        });
    }

    /**
     * Clears any pending sleeps with the given name.
     * @param {string} name
     * @returns {void}
     */
    function wake(name) {
        const existing = sleeps.get(name);
        if (existing !== undefined) {
            existing.forEach(t => clearTimeout(t));
            sleeps.delete(name);
        }
    }

    return { sleep, wake, withMutex };
}

module.exports = {
    make,
};
