/**
 * A constant-size, incrementally maintained fingerprint of the node shards.
 *
 * Each hashed member includes both the fixed-width physical key and the
 * canonical stored value. The XOR is order-independent, so a publication can
 * replace one affected node without reading unrelated nodes. The count plus
 * fingerprint detects absent, injected and corrupted members on routine load.
 */
const { createHash } = require("node:crypto");

const ZERO_DIGEST = "0".repeat(64);

/** @param {string} physicalKey @param {string} value */
function memberDigest(physicalKey, value) {
    return createHash("sha256")
        .update(physicalKey, "utf8").update("\0").update(value, "utf8")
        .digest("hex");
}

/** @param {string} left @param {string} right */
function xorDigest(left, right) {
    const first = Buffer.from(left, "hex");
    const second = Buffer.from(right, "hex");
    for (let index = 0; index < first.length; index++) {
        first[index] = (first[index] ?? 0) ^ (second[index] ?? 0);
    }
    return first.toString("hex");
}

module.exports = { ZERO_DIGEST, memberDigest, xorDigest };
