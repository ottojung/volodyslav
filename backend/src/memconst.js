
/**
 * This function takes another function of zero arguments and returns a memoized version of it.
 * Basically this always returns the same value. But it doesn't recompute it.
 * 
 * @template T The type of the value returned by the function
 * @param {() => T} fn A function that takes no arguments and returns a value of type T
 * @returns {() => T} A memoized function that returns the same value on every call
 */
function memconst(fn) {
    /** @type {T | undefined} */
    let memoizedValue;
    let computed = false;

    /**
     * @param {T | undefined} _x
     * @returns {_x is T}
     */
    function isComputed(_x) {
        return computed;
    }

    /**
     * @returns {T}
     */
    return function () {
        if (isComputed(memoizedValue)) {
            return memoizedValue;
        } else {
            memoizedValue = fn();
            computed = true;
            return memoizedValue;
        }
    };
}

module.exports = memconst;
