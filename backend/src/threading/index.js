
// FIXME: develop this subfolder into a proper module.

/**
 * @typedef {() => Promise<void>} Callback
 */

class PeriodicThread {
    /**
     * @private
     * @type {undefined} 
     */
    __brand = undefined; // nominal typing brand

    /** @type {string} */
    name;

    /** @type {number} */
    period;

    /** @type {Callback} */
    callback;

    /**
     * 
     * @param {string} name 
     * @param {number} period 
     * @param {Callback} callback 
     */
    constructor(name, period, callback) {
        this.name = name;
        this.period = period;
        this.callback = callback;
        this.interval = undefined;
        this.runningSet = new Set();
        if (this.__brand !== undefined) {
            throw new Error("PeriodicThread is a nominal type.");
        }
    }

    start() {
        const wrapped = async () => {
            this.runningSet.add(wrapped);
            try {
                return await this.callback();
            } finally {
                this.runningSet.delete(wrapped);
            }
        }

        if (this.interval === undefined) {
            this.interval = setInterval(wrapped, this.period);
        }
    }

    stop() {
        if (this.interval !== undefined) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
    }

    isRunning() {
        return this.interval !== undefined;
    }

    async join() {
        for (const running of this.runningSet) {
            await running;
        }
    }
}

/**
 *
 * @param {unknown} obj
 * @returns {obj is PeriodicThread}
 */
function isPeriodicThread(obj) {
    return obj instanceof PeriodicThread;
}

function make() {

    /**
     * @param {string} name
     * @param {number} interval
     * @param {Callback} callback
     * @returns {PeriodicThread}
     */
    function periodic(name, interval, callback) {
        return new PeriodicThread(name, interval, callback);
    }

    return {
        periodic,
    };
}

/**
 * @typedef {ReturnType<make>} Threading
 */

module.exports = {
    make,
    isPeriodicThread,
};
