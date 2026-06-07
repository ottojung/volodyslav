/**
 * Database module for generators.
 * Provides a LevelDB key-value store for storing generated values and event log mirrors.
 */

const {
    schemaPatternToString,
    stringToSchemaPattern,
    stringToNodeKeyString,
    stringToNodeIdentifier,
    unsafeStringToNodeIdentifier,
    nodeNameToString,
    stringToNodeName,
    nodeKeyStringToString,
    versionToString,
    stringToVersion,
} = require('./types');
const { makeRootDatabase, isRootDatabase, isInvalidReplicaPointerError, isSwitchReplicaError, isSchemaBatchVersionError, isMalformedIdentifierLookupError, MissingIdentifierLookupError, isMissingIdentifierLookupError, LAST_NODE_INDEX_KEY } = require('./root_database');
const { makeTypedDatabase, isTypedDatabase } = require('./typed_database');
const { isInvalidFingerprintError, isValidFingerprint, requireValidFingerprint } = require('./fingerprint');
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
} = require('./node_identifier');
const {
    IDENTIFIERS_KEY,
    allocateNodeIdentifier,
    cloneIdentifierLookup,
    mergeIdentifierLookups,
    deleteIdentifierMappingForNodeKey,
    IdentifierLookupError,
    isIdentifierLookupError,
    makeEmptyIdentifierLookup,
    makeIdentifierLookup,
    makeTransactionIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    requireNodeIdentifierForKey,
    requireNodeKeyForIdentifier,
    serializeIdentifierLookup,
    setIdentifierMapping,
    txAllocateNodeIdentifier,
    txNodeIdToKey,
    txNodeKeyToId,
    serializeTransactionLookup,
    commitTransactionLookup,
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
    isMalformedIdentifierLookupError,
    MissingIdentifierLookupError,
    isMissingIdentifierLookupError,
    isInvalidFingerprintError,
    isValidFingerprint,
    requireValidFingerprint,
    LAST_NODE_INDEX_KEY,
    makeTypedDatabase,
    isTypedDatabase,
    checkpointDatabase,
    checkpointMigration,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
    stringToNodeKeyString,
    stringToNodeIdentifier,
    unsafeStringToNodeIdentifier,
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
    IDENTIFIERS_KEY,
    allocateNodeIdentifier,
    cloneIdentifierLookup,
    mergeIdentifierLookups,
    deleteIdentifierMappingForNodeKey,
    IdentifierLookupError,
    isIdentifierLookupError,
    makeEmptyIdentifierLookup,
    makeIdentifierLookup,
    makeTransactionIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    requireNodeIdentifierForKey,
    requireNodeKeyForIdentifier,
    serializeIdentifierLookup,
    setIdentifierMapping,
    txAllocateNodeIdentifier,
    txNodeIdToKey,
    txNodeKeyToId,
    serializeTransactionLookup,
    commitTransactionLookup,
    unifyStores,
    makeDbToDbAdapter,
    makeInMemorySchemaStorage,
};
