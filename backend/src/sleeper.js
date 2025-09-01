/**
 * Sleeper capability for pausing execution.
 */

const uniqueSymbolModule = require("./unique_symbol");

/**
 * @typedef {object} Sleeper
 * @property {(ms: number) => Promise<void>} sleep - Pause for the given milliseconds.
 * @property {<T>(name: string | import('./unique_symbol').UniqueSymbol, procedure: () => Promise<T>) => Promise<T>} withMutex - Execute a procedure with a mutex lock.
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
     * @param {string | import('./unique_symbol').UniqueSymbol} name
     * @param {() => Promise<T>} procedure
     * @returns {Promise<T>}
     */
    async function withMutex(name, procedure) {
        // Convert UniqueSymbol to string if needed
        const mutexKey = uniqueSymbolModule.isUniqueSymbol(name) ? name.toString() : name;
        
        while (mutexes.has(mutexKey)) {
            await new Promise(resolve => setTimeout(resolve, 1));
        }

        mutexes.add(mutexKey);
        try {
            return await procedure();
        } finally {
            mutexes.delete(mutexKey);
        }
    }

    return { sleep, withMutex };
}

module.exports = {
    make,
};
