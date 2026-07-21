/** @typedef {{[fingerprint: string]: number}} ValueClock */

class ValueClockError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = 'ValueClockError';
    }
}

/**
 * @param {unknown} clock
 * @returns {ValueClock}
 */
function normalizeValueClock(clock) {
    if (clock === null || typeof clock !== 'object' || Array.isArray(clock)) {
        throw new ValueClockError('Value clock must be a non-array object');
    }
    /** @type {Array<[string, number]>} */
    const entries = [];
    for (const [host, counter] of Object.entries(clock)) {
        if (host.length === 0) {
            throw new ValueClockError('Value clock host fingerprint must be nonempty');
        }
        if (!Number.isInteger(counter) || counter <= 0) {
            throw new ValueClockError(`Value clock component for ${host} must be a positive integer`);
        }
        entries.push([host, counter]);
    }
    if (entries.length === 0) {
        throw new ValueClockError('Value clock must be nonempty');
    }
    entries.sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries);
}

/**
 * @param {unknown} clock
 * @returns {void}
 */
function validateValueClock(clock) {
    normalizeValueClock(clock);
}

/**
 * @param {ValueClock} left
 * @param {ValueClock} right
 * @returns {boolean}
 */
function valueClocksEqual(left, right) {
    const l = normalizeValueClock(left);
    const r = normalizeValueClock(right);
    const leftKeys = Object.keys(l);
    const rightKeys = Object.keys(r);
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index] && l[key] === r[key]);
}

/**
 * @param {ValueClock} left
 * @param {ValueClock} right
 * @returns {boolean}
 */
function valueClockDominates(left, right) {
    const l = normalizeValueClock(left);
    const r = normalizeValueClock(right);
    let strictlyGreater = false;
    for (const [host, rightCounter] of Object.entries(r)) {
        const leftCounter = l[host] ?? 0;
        if (leftCounter < rightCounter) return false;
        if (leftCounter > rightCounter) strictlyGreater = true;
    }
    for (const [host, leftCounter] of Object.entries(l)) {
        if (!(host in r) && leftCounter > 0) strictlyGreater = true;
    }
    return strictlyGreater;
}

/**
 * @param {ValueClock} left
 * @param {ValueClock} right
 * @returns {boolean}
 */
function valueClocksConcurrent(left, right) {
    return !valueClocksEqual(left, right)
        && !valueClockDominates(left, right)
        && !valueClockDominates(right, left);
}

/**
 * @param {ValueClock} left
 * @param {ValueClock} right
 * @returns {ValueClock}
 */
function joinValueClocks(left, right) {
    const l = normalizeValueClock(left);
    const r = normalizeValueClock(right);
    /** @type {{[fingerprint: string]: number}} */
    const joined = {};
    for (const host of new Set([...Object.keys(l), ...Object.keys(r)])) {
        joined[host] = Math.max(l[host] ?? 0, r[host] ?? 0);
    }
    return normalizeValueClock(joined);
}

/**
 * @param {ValueClock | undefined} clock
 * @param {string} localFingerprint
 * @returns {ValueClock}
 */
function incrementValueClock(clock, localFingerprint) {
    if (localFingerprint.length === 0) {
        throw new ValueClockError('Local fingerprint must be nonempty');
    }
    const base = clock === undefined ? {} : normalizeValueClock(clock);
    return normalizeValueClock({
        ...base,
        [localFingerprint]: (base[localFingerprint] ?? 0) + 1,
    });
}

module.exports = {
    ValueClockError,
    normalizeValueClock,
    validateValueClock,
    valueClocksEqual,
    valueClockDominates,
    valueClocksConcurrent,
    joinValueClocks,
    incrementValueClock,
};
