
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

    /** @type {import('luxon').Duration} */
    period;

    /** @type {Callback} */
    callback;

    /**
     * 
     * @param {string} name 
     * @param {import('luxon').Duration} period 
     * @param {Callback} callback 
     */
    constructor(name, period, callback) {
        this.name = name;
        this.period = period;
        this.callback = callback;
        this.interval = undefined;
        this.runningCount = 0;
        if (this.__brand !== undefined) {
            throw new Error("PeriodicThread is a nominal type.");
        }
    }

    start() {
        const wrapped = async () => {
            this.runningCount++;
            try {
                return await this.callback();
            } finally {
                this.runningCount--;
            }
        }

        if (this.interval === undefined) {
            this.interval = setInterval(wrapped, this.period.toMillis());
        }
    }

    async stop() {
        if (this.interval !== undefined) {
            clearInterval(this.interval);
            this.interval = undefined;
        }

        await this.join();
    }

    isRunning() {
        return this.runningCount > 0;
    }

    async join() {
        while (this.isRunning()) {
            await new Promise(resolve => setTimeout(resolve, 0));
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
     * @param {import('luxon').Duration} interval
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
