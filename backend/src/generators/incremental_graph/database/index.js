/**
 * Database module for generators.
 * Provides a LevelDB key-value store for storing generated values and event log mirrors.
 */

const { schemaPatternToString, stringToSchemaPattern, stringToNodeKeyString, nodeNameToString, stringToNodeName, nodeKeyStringToString, versionToString, stringToVersion } = require('./types');
const { makeRootDatabase, isRootDatabase, isInvalidReplicaPointerError, isSwitchReplicaError, isSchemaBatchVersionError } = require('./root_database');
const { makeTypedDatabase, isTypedDatabase } = require('./typed_database');
const {
    checkpointDatabase,
    runMigrationInTransaction,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
} = require('./gitstore');
const { synchronizeNoLock } = require('./synchronize');
const { renderToFilesystem, scanFromFilesystem, keyToRelativePath, relativePathToKey } = require('./render');
const {
    serializeNodeKey,
    deserializeNodeKey,
    createNodeKeyFromPattern,
    compareConstValue,
    compareNodeKey,
    compareNodeKeyStringByNodeKey,
} = require('./node_key');

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
    isInvalidReplicaPointerError,
    isSwitchReplicaError,
    isSchemaBatchVersionError,
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
    serializeNodeKey,
    deserializeNodeKey,
    createNodeKeyFromPattern,
    compareConstValue,
    compareNodeKey,
    compareNodeKeyStringByNodeKey,
};
