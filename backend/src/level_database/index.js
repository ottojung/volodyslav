

const { Level } = require('level');

/**
 * @typedef {import('../filesystem').checker.ExistingFile} ExistingFile
 */

/**
 * @template K, V
 * @param {ExistingFile} databasePath 
 * @returns {Level<K, V>}
 */
function initialize(databasePath) {
    return new Level(databasePath.path, { valueEncoding: 'json' });
}

function make() {
    return {
        initialize,
    }
}

/**
 * @typedef {object} LevelDatabase
 * @property {<K,V>(databasePath: ExistingFile) => Level<K, V>} initialize
 */

module.exports = {
    make,
};
