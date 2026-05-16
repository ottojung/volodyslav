/**
 * Database module for generators.
 * Provides a LevelDB key-value store for storing generated values and event log mirrors.
 */

const { schemaPatternToString, stringToSchemaPattern, stringToNodeKeyString, nodeNameToString, stringToNodeName, nodeKeyStringToString, versionToString, stringToVersion } = require('./types');
const { makeRootDatabase, isRootDatabase, isInvalidReplicaPointerError, isSwitchReplicaError, isSchemaBatchVersionError } = require('./root_database');
const { makeTypedDatabase, isTypedDatabase } = require('./typed_database');
const {
    checkpointDatabase,
    checkpointMigration,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
} = require('./gitstore');
const {
    synchronizeNoLock,
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
const {
    compareNodeIdentifier,
    databaseKeyToNodeIdentifier,
    makeNodeIdentifier,
    nodeIdentifierToDatabaseKey,
    nodeIdentifierFromString,
    nodeIdentifierToString,
    isInvalidNodeIdentifierError,
} = require('./node_identifier');
const {
    IDENTIFIERS_KEY,
    allocateNodeIdentifier,
    cloneIdentifierLookup,
    deleteIdentifierMappingForNodeKey,
    deterministicNodeIdentifierFromNodeKey,
    IdentifierAllocationError,
    IdentifierLookupError,
    isIdentifierAllocationError,
    isIdentifierLookupError,
    makeEmptyIdentifierLookup,
    makeIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    requireNodeIdentifierForKey,
    requireNodeKeyForIdentifier,
    serializeIdentifierLookup,
    setIdentifierMapping,
} = require('./identifier_lookup');

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
        isRootDatabase,
    isDatabaseInitializationError,
    isInvalidReplicaPointerError,
    isSwitchReplicaError,
    isSchemaBatchVersionError,
    makeTypedDatabase,
    isTypedDatabase,
    checkpointDatabase,
    checkpointMigration,
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
    compareNodeIdentifier,
    databaseKeyToNodeIdentifier,
    makeNodeIdentifier,
    nodeIdentifierToDatabaseKey,
    nodeIdentifierFromString,
    nodeIdentifierToString,
    isInvalidNodeIdentifierError,
    IDENTIFIERS_KEY,
    allocateNodeIdentifier,
    cloneIdentifierLookup,
    deleteIdentifierMappingForNodeKey,
    deterministicNodeIdentifierFromNodeKey,
    IdentifierAllocationError,
    IdentifierLookupError,
    isIdentifierAllocationError,
    isIdentifierLookupError,
    makeEmptyIdentifierLookup,
    makeIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    requireNodeIdentifierForKey,
    requireNodeKeyForIdentifier,
    serializeIdentifierLookup,
    setIdentifierMapping,
    unifyStores,
    makeDbToDbAdapter,
    makeInMemorySchemaStorage,
};
