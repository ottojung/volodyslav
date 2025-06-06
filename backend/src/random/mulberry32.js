
/**
 * Mulberry32 PRNG
 * @param {number} seed - 32-bit integer seed
 * @returns {() => number} Function returning a pseudorandom number in (0,1)
 */
function mulberry32(seed) {
    let t = seed >>> 0;

    /**
     * @returns {number} A pseudorandom number in [0, 1)
     * @description This function uses the Mulberry32 algorithm to generate a pseudorandom number.
     * The algorithm is based on a simple linear congruential generator.
     */
    function inclusive() {
        t += 0x6d2b79f5;
        let r = Math.imul(t ^ (t >>> 15), t | 1);
        r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    }

    /**
     * @returns {number} A pseudorandom number in (0, 1)
     * @description This function generates a pseudorandom number in the range (0, 1) by calling the inclusive function
     * and ensuring the result is not equal to 0.
     * It uses a while loop to keep generating numbers until a valid one is found.
     * This is a workaround for the fact that the inclusive function can return 0.
     */
    function exclusive() {
        let ret = 0;
        while (ret <= 0 || ret >= 1) {
            ret = inclusive();
        }
        return ret;
    }

    return exclusive;
}

module.exports = {
    mulberry32,
};
