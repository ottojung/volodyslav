
// FIXME: develop this subfolder into a proper module.

class PeriodicThread {
    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * 
     * @param {string} name 
     * @param {number} period 
     * @param {() => Promise<void>} callback 
     */
    constructor(name, period, callback) {
        this.name = name;
        this.period = period;
        this.callback = callback;
        this.interval = undefined;
    }

    start() {
        if (this.interval === undefined) {
            this.interval = setInterval(async () => {
                await this.callback();
            }, this.period);
        }
    }

    stop() {
        if (this.interval !== undefined) {
            clearInterval(this.interval);
            this.interval = undefined;
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
     * @param {() => Promise<void>} task
     * @returns {PeriodicThread}
     */
    function periodic(name, interval, task) {
        const ret = new PeriodicThread(name, interval, task);
        ret.start();
        return ret;
    }

    return {
        periodic,
    };
}

module.exports = {
    make,
    isPeriodicThread,
};
