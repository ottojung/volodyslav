/**
 * Core field calculation operations for mathematical cron algorithm.
 * Provides O(1) field-based calculations for cron expression matching.
 */

/**
 * Finds the next value in a sorted set that is greater than the given value.
 * @param {number} currentValue - Current value to find next from
 * @param {number[]} validSet - Sorted array of valid values
 * @returns {number|null} Next value in set, or null if none exists
 */
function nextInSet(currentValue, validSet) {
    // Binary search for efficiency with larger sets
    let left = 0;
    let right = validSet.length - 1;
    let result = null;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const midValue = validSet[mid];

        if (midValue > currentValue) {
            result = midValue;
            right = mid - 1; // Continue searching for a smaller valid value
        } else {
            left = mid + 1;
        }
    }

    return result;
}

/**
 * Finds the previous value in a sorted set that is less than the given value.
 * @param {number} currentValue - Current value to find previous from
 * @param {number[]} validSet - Sorted array of valid values
 * @returns {number|null} Previous value in set, or null if none exists
 */
function prevInSet(currentValue, validSet) {
    // Binary search for efficiency with larger sets
    let left = 0;
    let right = validSet.length - 1;
    let result = null;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const midValue = validSet[mid];

        if (midValue < currentValue) {
            result = midValue;
            left = mid + 1; // Continue searching for a larger valid value
        } else {
            right = mid - 1;
        }
    }

    return result;
}

/**
 * Gets the next value in set, with rollover to minimum if no next value exists.
 * @param {number} currentValue - Current value
 * @param {number[]} validSet - Sorted array of valid values
 * @returns {{value: number, rolledOver: boolean}}
 */
function nextInSetWithRollover(currentValue, validSet) {
    const next = nextInSet(currentValue, validSet);
    if (next !== null) {
        return { value: next, rolledOver: false };
    }
    
    // Rollover to minimum value
    return { value: validSet[0], rolledOver: true };
}

/**
 * Gets the previous value in set, with underflow to maximum if no previous value exists.
 * @param {number} currentValue - Current value
 * @param {number[]} validSet - Sorted array of valid values
 * @returns {{value: number, underflowed: boolean}}
 */
function prevInSetWithUnderflow(currentValue, validSet) {
    const prev = prevInSet(currentValue, validSet);
    if (prev !== null) {
        return { value: prev, underflowed: false };
    }
    
    // Underflow to maximum value
    return { value: validSet[validSet.length - 1], underflowed: true };
}

/**
 * Gets the minimum value from a set.
 * @param {number[]} validSet - Array of valid values
 * @returns {number}
 */
function minInSet(validSet) {
    return validSet[0];
}

/**
 * Gets the maximum value from a set.
 * @param {number[]} validSet - Array of valid values
 * @returns {number}
 */
function maxInSet(validSet) {
    return validSet[validSet.length - 1];
}

/**
 * Checks if a value is valid in the given set.
 * @param {number} value - Value to check
 * @param {number[]} validSet - Sorted array of valid values
 * @returns {boolean}
 */
function isValidInSet(value, validSet) {
    // Binary search for O(log n) performance
    let left = 0;
    let right = validSet.length - 1;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        const midValue = validSet[mid];

        if (midValue === value) {
            return true;
        } else if (midValue < value) {
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }

    return false;
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