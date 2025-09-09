
// FIXME: develop this subfolder into a proper module.

/**
 * @typedef {import('../datetime').Duration} Duration
 */

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

    /** @type {Duration} */
    period;

    /** @type {Callback} */
    callback;

    /**
     *
     * @param {string} name
     * @param {Duration} period
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

class ManualThread {
        /**
     * @private
     * @type {undefined} 
     */
    __brand = undefined; // nominal typing brand

    /** @type {string} */
    name;

    /** @type {Callback} */
    callback;

    /**
     *
     * @param {string} name
     * @param {Callback} callback
     */
    constructor(name, callback) {
        this.name = name;
        this.callback = callback;
        /** @type {NodeJS.Timeout[]} */
        this.timeouts = [];
        this.runningCount = 0;
        if (this.__brand !== undefined) {
            throw new Error("PeriodicThread is a nominal type.");
        }
    }

    /**
     * Start the thread after the given delay.
     * Multiple concurrent runs are allowed.
     * @param {Duration} after
     * @returns {void}
     */    
    start(after) {
        const wrapped = async () => {
            this.timeouts = this.timeouts.filter(t => t !== timeout);
            this.runningCount++;
            try {
                return await this.callback();
            } finally {
                this.runningCount--;
            }
        }

        const timeout = setTimeout(wrapped, after.toMillis());
        this.timeouts.push(timeout);
    }

    async stop() {
        if (this.timeouts.length > 0) {
            this.timeouts.forEach(t => clearTimeout(t));
            this.timeouts = [];
        }

        await this.join();
    }

    isRunning() {
        return this.runningCount > 0 || this.timeouts.length > 0;
    }

    async join() {
        while (this.isRunning()) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }
}

/**
 * @param {unknown} obj
 * @returns {obj is PeriodicThread}
 */
function isPeriodicThread(obj) {
    return obj instanceof PeriodicThread;
}

/**
 * @param {unknown} obj
 * @returns {obj is ManualThread}
 */
function isManualThread(obj) {
    return obj instanceof ManualThread;
}

function make() {

    /**
     * @param {string} name
     * @param {Duration} interval
     * @param {Callback} callback
     * @returns {PeriodicThread}
     */
    function periodic(name, interval, callback) {
        return new PeriodicThread(name, interval, callback);
    }

    /**
     * A version `periodic` that only runs once.
     * @param {string} name
     * @param {Callback} callback
     */
    function manual(name, callback) {
        return new ManualThread(name, callback);
    }

    return {
        periodic,
        manual,
    };
}

/**
 * @typedef {ReturnType<make>} Threading
 */

module.exports = {
    make,
    isPeriodicThread,
    isManualThread,
};
