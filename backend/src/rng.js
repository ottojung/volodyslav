// file: backend/src/rng.js
// Seedable pseudorandom number generator using Mulberry32 algorithm for reproducibility

const crypto = require("crypto");

/**
 * Mulberry32 PRNG
 * @param {number} seed - 32-bit integer seed
 * @returns {() => number} Function returning a pseudorandom number in [0,1)
 */
function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
        t += 0x6d2b79f5;
        let r = Math.imul(t ^ (t >>> 15), t | 1);
        r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

/** @class */
class RandomNumberGeneratorClass {
    /** @type {() => number} */
    _generate;

    /**
     * Nominal type brand
     * Its purpose is to make RNG a nominal type without actual use.
     * @private
     * @type {undefined}
     */
    __brand;

    /**
     * Creates a new RNG with the given integer seed.
     * @param {number} seed - 32-bit integer seed for reproducibility
     */
    constructor(seed) {
        if (!Number.isInteger(seed)) {
            throw new TypeError("Seed must be an integer");
        }
        // Store seed for inspection
        this._seed = seed;
        // Initialize PRNG
        this._generate = mulberry32(seed);
    }

    /**
     * Returns the next pseudorandom float in the range [0, 1).
     * @returns {number}
     */
    nextFloat() {
        return this._generate();
    }

    /**
     * Returns a pseudorandom integer in [min, max).
     * @param {number} min - Inclusive lower bound (integer)
     * @param {number} max - Exclusive upper bound (integer)
     * @returns {number}
     */
    nextInt(min, max) {
        if (!Number.isInteger(min) || !Number.isInteger(max)) {
            throw new TypeError("min and max must be integers");
        }
        if (max <= min) {
            throw new RangeError("max must be greater than min");
        }
        const range = max - min;
        return min + Math.floor(this._generate() * range);
    }

    /**
     * Returns the original seed used by this RNG.
     * (Not strictly necessary, but useful for inspection.)
     * @returns {number}
     */
    getSeed() {
        return this._seed;
    }
}

/** @typedef {RandomNumberGeneratorClass} RNG */

/**
 * Creates a new RNG with the given integer seed.
 * @param {number} seed - 32-bit integer seed
 * @returns {RNG}
 */
function createRNG(seed) {
    return new RandomNumberGeneratorClass(seed);
}

/**
 * Creates a new RNG with a random seed generated from crypto.
 * @returns {RNG}
 */
function createRandomRNG() {
    // Generate a 32-bit random seed
    const buf = crypto.randomBytes(4);
    const seed = buf.readUInt32LE(0);
    return new RandomNumberGeneratorClass(seed);
}

module.exports = { createRNG, createRandomRNG };
