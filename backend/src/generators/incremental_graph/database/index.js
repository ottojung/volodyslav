/**
 * Database module for generators.
 * Provides a LevelDB key-value store for storing generated values and event log mirrors.
 */

const { schemaPatternToString, stringToSchemaPattern, stringToNodeKeyString, nodeNameToString, stringToNodeName, nodeKeyStringToString, versionToString, stringToVersion } = require('./types');
const { makeRootDatabase, isRootDatabase, isInvalidReplicaPointerError, isSwitchReplicaError, isSchemaBatchVersionError, FORMAT_MARKER } = require('./root_database');
const { makeTypedDatabase, isTypedDatabase } = require('./typed_database');
const {
    checkpointDatabase,
    runMigrationInTransaction,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
} = require('./gitstore');
const {
    synchronizeNoLock,
    InvalidSnapshotFormatError,
    isInvalidSnapshotFormatError,
    InvalidSnapshotReplicaError,
    isInvalidSnapshotReplicaError,
    isSyncMergeAggregateError,
} = require('./synchronize');
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
/** @typedef {import('./unification').ReadableSchemaStorage} ReadableSchemaStorage */

const {
    isDatabaseInitializationError,
    getRootDatabase,
} = require('./get_root_database');

const {
    unifyStores,
    makeDbToDbAdapter,
    makeInMemorySchemaStorage,
} = require('./unification');

module.exports = {
    getRootDatabase,
    makeRootDatabase,
    FORMAT_MARKER,
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
    InvalidSnapshotFormatError,
    isInvalidSnapshotFormatError,
    InvalidSnapshotReplicaError,
    isInvalidSnapshotReplicaError,
    isSyncMergeAggregateError,
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
    unifyStores,
    makeDbToDbAdapter,
    makeInMemorySchemaStorage,
};
