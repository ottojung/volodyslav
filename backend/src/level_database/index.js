

const { Level } = require('level');

/**
 * @typedef {import('../filesystem').checker.ExistingFile} ExistingFile
 */

/**
 * @template K, V
 * @param {string} databasePath 
 * @returns {Level<K, V>}
 */
function initialize(databasePath) {
    return new Level(databasePath, { valueEncoding: 'json' });
}

function make() {
    return {
        initialize,
    }
}

/**
 * @typedef {object} LevelDatabase
 * @property {<K,V>(databasePath: string) => Level<K, V>} initialize
 */

module.exports = {
    make,
};
