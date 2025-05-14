
/**
 * This function takes another function of zero arguments and returns a memoized version of it.
 * Basically this always returns the same value. But it doesn't recompute it.
 */
function memconst(fn) {
    let memoizedValue;
    let computed = false;

    return function () {
        if (computed) {
            return memoizedValue;
        } else {
            memoizedValue = fn();
            computed = true;
            return memoizedValue;
        }
    };
}

module.exports = memconst;
