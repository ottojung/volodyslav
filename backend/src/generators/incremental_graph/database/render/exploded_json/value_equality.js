/** @param {unknown} first @param {unknown} second @returns {boolean} */
function jsonStructuralEquals(first, second) {
    if (typeof first === 'number' && typeof second === 'number') return first === second || (Object.is(first, -0) && Object.is(second, 0)) || (Object.is(first, 0) && Object.is(second, -0));
    if (first === null || second === null || typeof first !== 'object' || typeof second !== 'object') return first === second;
    if (Array.isArray(first) || Array.isArray(second)) {
        if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length) return false;
        return first.every((value, index) => jsonStructuralEquals(value, second[index]));
    }
    const firstEntries = Object.entries(first);
    const secondEntries = Object.entries(second);
    if (firstEntries.length !== secondEntries.length) return false;
    return firstEntries.every(([key, value]) => {
        const matchingEntry = secondEntries.find(([secondKey]) => secondKey === key);
        return matchingEntry !== undefined && jsonStructuralEquals(value, matchingEntry[1]);
    });
}
module.exports = { jsonStructuralEquals };
