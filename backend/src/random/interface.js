/**
 * @typedef {Object} RNG
 * @property {() => number} nextFloat - Returns a pseudorandom float in (0, 1).
 * @property {(min: number, max: number) => number} nextInt - Returns a pseudorandom integer in [min, max].
 * @description Interface for a random number generator.
 */

/**
 *
 * @param {() => number} nextFloat - A function that returns a pseudorandom float in (0, 1).
 * @returns {(min: number, max: number) => number} - A function that returns a pseudorandom integer in [min, max].
 */
function fromFloatGenerator(nextFloat) {
    /**
     * @param {number} min - Inclusive lower bound (integer)
     * @param {number} max - Inclusive upper bound (integer)
     * @returns {number}
     */
    function nextInt(min, max) {
        if (!Number.isInteger(min) || !Number.isInteger(max)) {
            throw new TypeError("min and max must be integers");
        }
        if (max < min) {
            throw new RangeError("max must be greater or equal than min");
        }

        const range = max + 1 - min;
        return min + Math.floor(nextFloat() * range);
    }

    return nextInt;
}

/**
 * @param {RNG | {nextFloat: () => number}} partiallyInitializedRng
 * @returns {RNG}
 * @description Takes a partially initialized RNG and returns a fully initialized RNG.
 */
function make(partiallyInitializedRng) {
    function getNextFloat() {
        return partiallyInitializedRng.nextFloat;
    }

    function getNextInt() {
        if ('nextInt' in partiallyInitializedRng) {
            return partiallyInitializedRng.nextInt;
        }

        return fromFloatGenerator(partiallyInitializedRng.nextFloat);
    }

    return {
        nextFloat: getNextFloat(),
        nextInt: getNextInt(),
    };
}

module.exports = {
    make,
};
