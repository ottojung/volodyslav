/**
 * Core field calculation operations for mathematical cron algorithm.
 */

/**
 * Finds the next value in a sorted set that is greater than the given value.
 * @param {number} currentValue - Current value to find next from
 * @param {boolean[]} validSet - Sorted array of valid values
 * @returns {number|null} Next value in set, or null if none exists
 */
function nextInSet(currentValue, validSet) {
    for (let i = currentValue + 1; i < validSet.length; i++) {
        const val = validSet[i];
        if (val === true) {
            return i;
        }
    }

    return null;
}

/**
 * Finds the previous value in a sorted set that is less than the given value.
 * @param {number} currentValue - Current value to find previous from
 * @param {boolean[]} validSet - Sorted array of valid values
 * @returns {number|null} Previous value in set, or null if none exists
 */
function prevInSet(currentValue, validSet) {
    for (let i = currentValue - 1; i >= 0; i--) {
        const val = validSet[i];
        if (val === true) {
            return i;
        }
    }    

    return null;
}

/**
 * Gets the next value in set, with rollover to minimum if no next value exists.
 * @param {number} currentValue - Current value
 * @param {boolean[]} validSet - A mask of valid values
 * @returns {{value: number, rolledOver: boolean}}
 */
function nextInSetWithRollover(currentValue, validSet) {
    const next = nextInSet(currentValue, validSet);
    if (next !== null) {
        return { value: next, rolledOver: false };
    }
    
    // Rollover to minimum value
    for (let i = 0; i < validSet.length; i++) {
        const val = validSet[i];
        if (val === true) {
            return { value: i, rolledOver: true };
        }
    }

    throw new Error("Cannot get minimum value from empty set");
}

/**
 * Gets the previous value in set, with underflow to maximum if no previous value exists.
 * @param {number} currentValue - Current value
 * @param {boolean[]} validSet - A mask of valid values
 * @returns {{value: number, underflowed: boolean}}
 */
function prevInSetWithUnderflow(currentValue, validSet) {
    const prev = prevInSet(currentValue, validSet);
    if (prev !== null) {
        return { value: prev, underflowed: false };
    }

    for (let i = validSet.length - 1; i > currentValue; i--) {
        const val = validSet[i];
        if (val === true) {
            return { value: i, underflowed: true };
        }
    }

    throw new Error("Cannot get maximum value from empty set");
}

/**
 * Gets the minimum value from a set.
 * @param {boolean[]} validSet - Array of valid values
 * @returns {number}
 */
function minInSet(validSet) {
    for (let i = 0; i < validSet.length; i++) {
        const val = validSet[i];
        if (val === true) {
            return i;
        }
    }

    throw new Error("Cannot get minimum value from empty set");
}

/**
 * Gets the maximum value from a set.
 * @param {boolean[]} validSet - Array of valid values
 * @returns {number}
 */
function maxInSet(validSet) {
    for (let i = validSet.length - 1; i >= 0; i--) {
        const val = validSet[i];
        if (val === true) {
            return i;
        }
    }    

    throw new Error("Cannot get maximum value from empty set");
}

/**
 * Checks if a value is valid in the given set.
 * @param {number} value - Value to check
 * @param {boolean[]} validSet - A mask of valid values
 * @returns {boolean}
 */
function isValidInSet(value, validSet) {
    return validSet[value] === true;
}

module.exports = {
    nextInSet,
    prevInSet,
    nextInSetWithRollover,
    prevInSetWithUnderflow,
    minInSet,
    maxInSet,
    isValidInSet,
};