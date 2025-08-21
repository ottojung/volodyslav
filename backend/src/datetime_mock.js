/**
 * Mocked datetime capability for testing that allows time control.
 * This extends the regular Datetime interface with time manipulation capabilities.
 */

const { DateTime } = require("./datetime");

/**
 * @typedef {object} MockedDatetime
 * @property {() => DateTime} now - Returns the current mocked datetime.
 * @property {(ms: number) => DateTime} fromEpochMs - Creates a DateTime from milliseconds.
 * @property {(iso: string) => DateTime} fromISOString - Creates a DateTime from ISO string.
 * @property {(dt: DateTime) => number} toEpochMs - Converts DateTime to epoch milliseconds.
 * @property {(dt: DateTime) => string} toISOString - Converts DateTime to ISO string.
 * @property {(dt: DateTime) => Date} toNativeDate - Converts DateTime to native Date.
 * @property {(ms: number) => void} setTime - Sets the current mocked time to specific epoch milliseconds.
 * @property {(ms: number) => void} advanceTime - Advances the current mocked time by specified milliseconds.
 * @property {() => number} getCurrentTime - Gets the current mocked time as epoch milliseconds.
 */

class MockedDatetimeClass {
    /** @type {undefined} */
    __brand = undefined;

    constructor() {
        // Initialize with current real time, but this can be overridden
        this._currentTimeMs = Date.now();
        if (this.__brand !== undefined) {
            throw new Error("MockedDatetime is nominal");
        }
    }

    /**
     * Returns the current mocked datetime.
     * @returns {DateTime}
     */
    now() {
        return new DateTime(new Date(this._currentTimeMs));
    }

    /**
     * @param {number} ms
     * @returns {DateTime}
     */
    fromEpochMs(ms) {
        return new DateTime(new Date(ms));
    }

    /**
     * @param {string} iso
     * @returns {DateTime}
     */
    fromISOString(iso) {
        return new DateTime(new Date(iso));
    }

    /**
     * @param {DateTime} dt
     * @returns {number}
     */
    toEpochMs(dt) {
        return dt.getTime();
    }

    /**
     * @param {DateTime} dt
     * @returns {string}
     */
    toISOString(dt) {
        return dt.toISOString();
    }

    /**
     * @param {DateTime} dt
     * @returns {Date}
     */
    toNativeDate(dt) {
        return dt.toDate();
    }

    /**
     * Sets the current mocked time to specific epoch milliseconds.
     * @param {number} ms - The time to set as epoch milliseconds
     */
    setTime(ms) {
        this._currentTimeMs = ms;
    }

    /**
     * Advances the current mocked time by specified milliseconds.
     * @param {number} ms - Number of milliseconds to advance
     */
    advanceTime(ms) {
        this._currentTimeMs += ms;
    }

    /**
     * Gets the current mocked time as epoch milliseconds.
     * @returns {number}
     */
    getCurrentTime() {
        return this._currentTimeMs;
    }
}

/**
 * Creates a new mocked datetime instance.
 * @returns {MockedDatetime}
 */
function makeMockedDatetime() {
    return new MockedDatetimeClass();
}

/**
 * Type guard for MockedDatetime.
 * @param {any} obj
 * @returns {obj is MockedDatetime}
 */
function isMockedDatetime(obj) {
    return obj instanceof MockedDatetimeClass;
}

module.exports = {
    makeMockedDatetime,
    isMockedDatetime,
};