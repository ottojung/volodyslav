
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

module.exports = {
    mulberry32,
};
