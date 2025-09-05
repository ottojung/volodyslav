/**
 * Core field calculation operations for boolean mask cron algorithm.
 * Provides O(1) field-based calculations for cron expression matching.
 */

/**
 * Finds the next value in a boolean mask that is greater than the given value.
 * @param {number} currentValue - Current value to find next from
 * @param {boolean[]} validMask - Boolean mask where true indicates valid values
 * @returns {number|null} Next value in mask, or null if none exists
 */
function nextInSet(currentValue, validMask) {
    for (let i = currentValue + 1; i < validMask.length; i++) {
        if (validMask[i]) {
            return i;
        }
    }
    return null;
}

/**
 * Finds the previous value in a boolean mask that is less than the given value.
 * @param {number} currentValue - Current value to find previous from
 * @param {boolean[]} validMask - Boolean mask where true indicates valid values
 * @returns {number|null} Previous value in mask, or null if none exists
 */
function prevInSet(currentValue, validMask) {
    for (let i = currentValue - 1; i >= 0; i--) {
        if (validMask[i]) {
            return i;
        }
    }
    return null;
}

/**
 * Gets the next value in mask, with rollover to minimum if no next value exists.
 * @param {number} currentValue - Current value
 * @param {boolean[]} validMask - Boolean mask where true indicates valid values
 * @returns {{value: number, rolledOver: boolean}}
 */
function nextInSetWithRollover(currentValue, validMask) {
    const next = nextInSet(currentValue, validMask);
    if (next !== null) {
        return { value: next, rolledOver: false };
    }
    
    // Rollover to minimum value
    const minValue = minInSet(validMask);
    return { value: minValue, rolledOver: true };
}

/**
 * Gets the previous value in mask, with underflow to maximum if no previous value exists.
 * @param {number} currentValue - Current value
 * @param {boolean[]} validMask - Boolean mask where true indicates valid values
 * @returns {{value: number, underflowed: boolean}}
 */
function prevInSetWithUnderflow(currentValue, validMask) {
    const prev = prevInSet(currentValue, validMask);
    if (prev !== null) {
        return { value: prev, underflowed: false };
    }
    
    // Underflow to maximum value
    const maxValue = maxInSet(validMask);
    return { value: maxValue, underflowed: true };
}

/**
 * Gets the minimum value from a boolean mask.
 * @param {boolean[]} validMask - Boolean mask where true indicates valid values
 * @returns {number}
 */
function minInSet(validMask) {
    for (let i = 0; i < validMask.length; i++) {
        if (validMask[i]) {
            return i;
        }
    }
    throw new Error("Cannot get minimum value from empty set");
}

/**
 * Gets the maximum value from a boolean mask.
 * @param {boolean[]} validMask - Boolean mask where true indicates valid values
 * @returns {number}
 */
function maxInSet(validMask) {
    for (let i = validMask.length - 1; i >= 0; i--) {
        if (validMask[i]) {
            return i;
        }
    }
    throw new Error("Cannot get maximum value from empty set");
}

/**
 * Checks if a value is valid in the given boolean mask.
 * @param {number} value - Value to check
 * @param {boolean[]} validMask - Boolean mask where true indicates valid values
 * @returns {boolean}
 */
function isValidInSet(value, validMask) {
    return value >= 0 && value < validMask.length && validMask[value] === true;
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