/**
 * Validates and normalizes a top-level database sublevel name used by
 * renderToFilesystem/scanFromFilesystem.
 *
 * @param {unknown} sublevel
 * @returns {string}
 */
function validateTopLevelSublevel(sublevel) {
    if (typeof sublevel !== 'string') {
        throw new Error(`Invalid sublevel: expected a string, got ${typeof sublevel}`);
    }
    if (sublevel.length === 0) {
        throw new Error('Invalid sublevel: must be a non-empty string');
    }
    if (sublevel === '.' || sublevel === '..') {
        throw new Error(`Invalid sublevel '${sublevel}': "." and ".." are not allowed`);
    }
    if (sublevel.includes('/') || sublevel.includes('\\')) {
        throw new Error(`Invalid sublevel '${sublevel}': path separators are not allowed`);
    }
    return sublevel;
}

module.exports = {
    validateTopLevelSublevel,
};
