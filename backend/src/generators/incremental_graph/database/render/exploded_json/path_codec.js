const { encodeSegment, decodeSegment } = require('../../encoding');

/** @param {string} objectKey @returns {string} */
function encodeObjectKeySegment(objectKey) { return encodeSegment(objectKey); }
/** @param {string} segment @returns {string} */
function decodeObjectKeySegment(segment) { return decodeSegment(segment); }
/** @param {string} parent @param {string} child @returns {string} */
function appendDescendantPath(parent, child) { return parent === '' ? child : `${parent}/${child}`; }
/** @param {number} index @returns {string} */
function encodeArrayIndex(index) { return String(index); }

module.exports = { encodeObjectKeySegment, decodeObjectKeySegment, appendDescendantPath, encodeArrayIndex };
