/**
 * Database module for generators.
 * Provides a LevelDB key-value store for storing generated values and event log mirrors.
 */

const { schemaPatternToString, stringToSchemaPattern, stringToNodeKeyString, nodeNameToString, stringToNodeName, nodeKeyStringToString, versionToString, stringToVersion } = require('./types');
const { makeRootDatabase, isRootDatabase } = require('./root_database');
const { makeTypedDatabase, isTypedDatabase } = require('./typed_database');
const {
    checkpointDatabase,
    runMigrationInTransaction,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
} = require('./gitstore');
const { synchronizeNoLock } = require('./synchronize');
const { renderToFilesystem } = require('./render');
const { scanFromFilesystem } = require('./scan');
const { keyToRelativePath, relativePathToKey } = require('./encoding');

/** @typedef {import('./types').DatabaseCapabilities} DatabaseCapabilities */

const {
    isDatabaseInitializationError,
    getRootDatabase,
} = require('./get_root_database');

module.exports = {
    getRootDatabase,
    makeRootDatabase,
    isRootDatabase,
    isDatabaseInitializationError,
    makeTypedDatabase,
    isTypedDatabase,
    checkpointDatabase,
    runMigrationInTransaction,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
    stringToNodeKeyString,
    nodeNameToString,
    stringToNodeName,
    nodeKeyStringToString,
    schemaPatternToString,
    stringToSchemaPattern,
    versionToString,
    stringToVersion,
    synchronizeNoLock,
    renderToFilesystem,
    scanFromFilesystem,
    keyToRelativePath,
    relativePathToKey,
};
