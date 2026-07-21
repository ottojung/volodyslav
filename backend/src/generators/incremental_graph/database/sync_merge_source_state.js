const {
    normalizeValueClock,
    valueClocksEqual,
    valueClockDominates,
    joinValueClocks,
} = require('./value_clock');
const { IdentifierLookupConflictError } = require('./replica_errors');
const { nodeIdentifierToString } = require('./types');

/** @typedef {import('./root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./value_clock').ValueClock} ValueClock */

/**
 * @typedef {{kind: 'absent'} | {kind: 'materialized', side: 'keep' | 'take', identifier: NodeIdentifier, clock: ValueClock} | {kind: 'conflicted', frontier: ValueClock}} SourceState
 */

/**
 * @typedef {{kind: 'absent'} | {kind: 'materialized', side: 'keep' | 'take', identifier: NodeIdentifier, clock: ValueClock} | {kind: 'conflicted', frontier: ValueClock}} MergedSourceState
 */

/**
 * @param {SchemaStorage} storage
 * @param {IdentifierLookup} lookup
 * @param {'keep' | 'take'} side
 * @param {NodeKeyString} nodeKey
 * @returns {Promise<SourceState>}
 */
async function readSourceState(storage, lookup, side, nodeKey) {
    const identifier = lookup.keyToId.get(String(nodeKey));
    const frontier = await storage.conflictFrontiers.get(nodeKey);
    if (identifier !== undefined && frontier !== undefined) {
        throw new IdentifierLookupConflictError(`Semantic key ${String(nodeKey)} is both materialized and conflicted`);
    }
    if (frontier !== undefined) {
        return { kind: 'conflicted', frontier: normalizeValueClock(frontier) };
    }
    if (identifier === undefined) {
        return { kind: 'absent' };
    }
    const clock = await storage.valueClocks.get(identifier);
    if (clock === undefined) {
        throw new IdentifierLookupConflictError(`Materialized node ${nodeIdentifierToString(identifier)} has no value clock`);
    }
    return { kind: 'materialized', side, identifier, clock: normalizeValueClock(clock) };
}

/**
 * @param {SourceState} left
 * @param {SourceState} right
 * @returns {MergedSourceState}
 */
function mergeSourceStates(left, right) {
    if (left.kind === 'absent') return right;
    if (right.kind === 'absent') return left;
    if (left.kind === 'conflicted' && right.kind === 'conflicted') {
        return { kind: 'conflicted', frontier: joinValueClocks(left.frontier, right.frontier) };
    }
    if (left.kind === 'materialized' && right.kind === 'materialized') {
        if (valueClocksEqual(left.clock, right.clock)) return left;
        if (valueClockDominates(left.clock, right.clock)) return left;
        if (valueClockDominates(right.clock, left.clock)) return right;
        return { kind: 'conflicted', frontier: joinValueClocks(left.clock, right.clock) };
    }
    if (left.kind === 'materialized' && right.kind === 'conflicted') {
        if (valueClockDominates(left.clock, right.frontier)) return left;
        return { kind: 'conflicted', frontier: joinValueClocks(left.clock, right.frontier) };
    }
    if (left.kind === 'conflicted' && right.kind === 'materialized') {
        if (valueClockDominates(right.clock, left.frontier)) return right;
        return { kind: 'conflicted', frontier: joinValueClocks(right.clock, left.frontier) };
    }
    return { kind: 'absent' };
}

module.exports = { readSourceState, mergeSourceStates };
