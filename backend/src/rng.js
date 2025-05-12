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
class Mulberry32Generator {
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
        // Initialize PRNG function
        this._generate = mulberry32(seed);
    }

    /**
     * Returns a pseudorandom integer in [min, max).
     * @param {number} min - Inclusive lower bound (integer)
     * @param {number} max - Inclusive upper bound (integer)
     * @returns {number}
     */
    nextInt(min, max) {
        if (!Number.isInteger(min) || !Number.isInteger(max)) {
            throw new TypeError("min and max must be integers");
        }
        if (max < min) {
            throw new RangeError("max must be greater or equal than min");
        }

        const range = max + 1 - min;
        // Note: using this._generate() instead of this.nextFloat() because we need 0.
        return min + Math.floor(this._generate() * range);
    }

    /**
     * Returns the next pseudorandom float in (0, 1), exclusive of both endpoints.
     * @returns {number}
     */
    nextFloat() {
        let v;
        // retry if we hit boundaries (<=0 or >=1)
        do {
            v = this._generate();
        } while (v <= 0 || v >= 1);
        return v;
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

/**
 * @typedef {Object} RNG
 * @property {() => number} nextFloat - Returns a pseudorandom float in (0, 1).
 * @property {(min: number, max: number) => number} nextInt - Returns a pseudorandom integer in [min, max].
 * @description Interface for a random number generator.
 */

/**
 * Creates a new RNG with the given integer seed.
 * @param {number} seed - 32-bit integer seed
 * @returns {RNG}
 */
function createRNG(seed) {
    return new Mulberry32Generator(seed);
}

/**
 * Creates a new RNG with a random seed generated from crypto.
 * @returns {RNG}
 */
function createRandomRNG() {
    // Generate a 32-bit random seed
    const buf = crypto.randomBytes(4);
    const seed = buf.readUInt32LE(0);
    return new Mulberry32Generator(seed);
}

module.exports = { createRNG, createRandomRNG };
