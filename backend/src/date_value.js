class DateValueClass {
    /** @type {Date} */
    #value;

    /** @type {undefined} */
    __brand;

    /**
     * @param {Date} value
     */
    constructor(value) {
        this.#value = value;
        if (this.__brand !== undefined) {
            throw new Error('DateValue is a nominal type and should not be instantiated directly');
        }
    }

    getFullYear() { return this.#value.getFullYear(); }
    getMonth() { return this.#value.getMonth(); }
    getDate() { return this.#value.getDate(); }
    getTime() { return this.#value.getTime(); }
    getUTCFullYear() { return this.#value.getUTCFullYear(); }
    getUTCMonth() { return this.#value.getUTCMonth(); }
    getUTCDate() { return this.#value.getUTCDate(); }
    getUTCHours() { return this.#value.getUTCHours(); }
    getUTCMinutes() { return this.#value.getUTCMinutes(); }
    getUTCSeconds() { return this.#value.getUTCSeconds(); }
    toISOString() { return this.#value.toISOString(); }
    /**
     * @param {...any} args
     * @returns {string}
     */
    toLocaleDateString(...args) {
        return this.#value.toLocaleDateString(...args);
    }
}

/** @typedef {DateValueClass} DateValue */

/**
 * @param {number} timestamp
 * @returns {DateValue}
 */
function fromTimestamp(timestamp) {
    return new DateValueClass(new Date(timestamp));
}

/**
 * @param {string} isoString
 * @returns {DateValue}
 */
function fromISOString(isoString) {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) {
        throw new Error(`Invalid date string: ${isoString}`);
    }
    return new DateValueClass(d);
}

/**
 * @param {unknown} object
 * @returns {object is DateValue}
 */
function isDateValue(object) {
    return object instanceof DateValueClass;
}

module.exports = {
    fromTimestamp,
    fromISOString,
    isDateValue,
};
