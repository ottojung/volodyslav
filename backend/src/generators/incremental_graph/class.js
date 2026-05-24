/**
 * IncrementalGraph class for propagating data through dependency edges.
 */

const { createHook, executionAsyncId } = require("async_hooks");

/** @typedef {import('./database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('./types').NodeDef} NodeDef */
/** @typedef {import('./types').CompiledNode} CompiledNode */
/** @typedef {import('./types').ConcreteNode} ConcreteNode */
/** @typedef {import('./types').ResolvedConcreteNode} ResolvedConcreteNode */
/** @typedef {import('./types').ConstValue} ConstValue */
/** @typedef {import('./types').ComputedValue} ComputedValue */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./types').RecomputeResult} RecomputeResult */
/** @typedef {import('./graph_storage').GraphStorage} GraphStorage */
/** @typedef {import('./graph_storage').BatchBuilder} BatchBuilder */
/** @typedef {import('./lru_cache').ConcreteNodeCache} ConcreteNodeCache */
/** @typedef {import('../../datetime').DateTime} DateTime */
/** @typedef {import('../../datetime').Datetime} Datetime */
/** @typedef {import('../../sleeper').SleepCapability} SleepCapability */
/** @typedef {import('./types').IncrementalGraphCapabilities} IncrementalGraphCapabilities */
/** @typedef {import('./identifier_resolver').IdentifierResolver} IdentifierResolver */
/**
 * @typedef {object} PullContext
 * @property {IdentifierResolver} identifierResolver
 * @property {BatchBuilder} batch
 */
/**
 * @typedef {PullContext & { ownerAsyncIds: Set<number> }} PullContextFrame
 */
/**
 * Active pull-context frames across all IncrementalGraph instances.
 * Each frame tracks the async resources that belong to that context.
 *
 * @type {Set<PullContextFrame>}
 */
const activePullContextFrames = new Set();
/** @type {Map<number, Set<PullContextFrame>>} */
const pullContextFramesByAsyncId = new Map();

/**
 * @param {number} asyncId
 * @param {PullContextFrame} frame
 * @returns {void}
 */
function addFrameAsyncOwnership(asyncId, frame) {
    frame.ownerAsyncIds.add(asyncId);
    const existing = pullContextFramesByAsyncId.get(asyncId);
    if (existing !== undefined) {
        existing.add(frame);
        return;
    }
    pullContextFramesByAsyncId.set(asyncId, new Set([frame]));
}

/**
 * @param {number} asyncId
 * @returns {void}
 */
function releaseAsyncOwnership(asyncId) {
    const frames = pullContextFramesByAsyncId.get(asyncId);
    if (frames === undefined) {
        return;
    }
    for (const frame of frames) {
        frame.ownerAsyncIds.delete(asyncId);
    }
    pullContextFramesByAsyncId.delete(asyncId);
}
/**
 * Track async-resource lineage for active pull contexts.
 *
 * We register ownership on `init` by inheriting from the triggering async
 * resource. Cleanup runs on both `destroy` and `promiseResolve` because not all
 * async resources consistently emit only one lifecycle signal in practice.
 */
createHook({
    init(asyncId, _type, triggerAsyncId) {
        const inheritedFrames = pullContextFramesByAsyncId.get(triggerAsyncId);
        if (inheritedFrames === undefined) {
            return;
        }
        for (const frame of inheritedFrames) {
            addFrameAsyncOwnership(asyncId, frame);
        }
    },
    destroy(asyncId) {
        releaseAsyncOwnership(asyncId);
    },
    promiseResolve(asyncId) {
        releaseAsyncOwnership(asyncId);
    },
}).enable();

const {
    compileNodeDef,
    validateAcyclic,
    validateInputArities,
    validateNoOverlap,
    validateSingleArityPerHead,
} = require("./compiled_node");
const { makeGraphStorage } = require("./graph_storage");
const { getActiveLookup } = require("./identifier_resolver");
const {
    nodeKeyToIdFromLookup,
    nodeIdToKeyFromLookup,
} = require("./database");
const {
    internalGetDbVersion,
    internalGetFreshness,
    internalGetSchemaByHead,
    internalGetSchemas,
    internalGetValue,
    internalListMaterializedNodes,
    internalGetCreationTime,
    internalGetModificationTime,
} = require("./inspection");
const {
    internalInvalidate,
    internalPropagateOutdated,
    internalUnsafeInvalidate,
} = require("./invalidate");
const { internalGetOrCreateConcreteNode } = require("./instantiation");
const { makeConcreteNodeCache } = require("./lru_cache");
const {
    internalPull,
    internalPullByNodeKeyWithStatusDuringPull,
    internalSafePullWithStatus,
    internalUnsafePull,
} = require("./pull");
const { internalMaybeRecalculate } = require("./recompute");

class IncrementalGraphClass {
    /** @type {Map<import('./types').NodeName, CompiledNode>} */
    headIndex;

    /** @type {ConcreteNodeCache} */
    concreteInstantiations;

    /** @type {GraphStorage} */
    storage;

    /** @type {import('./types').Version} */
    dbVersion;

    /** @type {SleepCapability} */
    sleeper;

    /** @type {Datetime} */
    datetime;

    /** @type {RootDatabase} */
    rootDatabase;

    /** @type {Array<PullContextFrame>} */
    _activePullContexts;

    /**
     * @param {IncrementalGraphCapabilities} capabilities
     * @param {RootDatabase} rootDatabase
     * @param {Array<NodeDef>} nodeDefs
     */
    constructor(capabilities, rootDatabase, nodeDefs) {
        const compiledNodes = nodeDefs.map(compileNodeDef);
        validateNoOverlap(compiledNodes);
        validateAcyclic(compiledNodes);
        validateSingleArityPerHead(compiledNodes);
        validateInputArities(compiledNodes);

        this.storage = makeGraphStorage(rootDatabase, capabilities.sleeper);
        this.rootDatabase = rootDatabase;
        this.dbVersion = rootDatabase.version;
        this.headIndex = new Map();
        for (const compiledNode of compiledNodes) {
            this.headIndex.set(compiledNode.head, compiledNode);
        }

        this.concreteInstantiations = makeConcreteNodeCache();
        this.sleeper = capabilities.sleeper;
        this.datetime = capabilities.datetime;
        this._activePullContexts = [];
    }

    /**
     * @param {import('./types').NodeIdentifier} changedKey
     * @param {BatchBuilder} batch
     * @param {Set<string>} [nodesBecomingOutdated]
     * @returns {Promise<void>}
     */
    async propagateOutdated(changedKey, batch, nodesBecomingOutdated = new Set()) {
        await internalPropagateOutdated(
            this,
            changedKey,
            batch,
            nodesBecomingOutdated
        );
    }

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} bindings
     * @returns {Promise<void>}
     */
    async unsafeInvalidate(nodeName, bindings) {
        await internalUnsafeInvalidate(this, nodeName, bindings);
    }

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<void>}
     */
    async invalidate(nodeName, bindings = []) {
        await internalInvalidate(this, nodeName, bindings);
    }

    /**
     * @param {import('./types').NodeKeyString} concreteKeyCanonical
     * @param {CompiledNode} compiledNode
     * @param {Array<ConstValue>} bindings
     * @returns {ConcreteNode}
     */
    getOrCreateConcreteNode(concreteKeyCanonical, compiledNode, bindings) {
        return internalGetOrCreateConcreteNode(
            this,
            concreteKeyCanonical,
            compiledNode,
            bindings
        );
    }

    /**
     * Look up the semantic node key for a given identifier.
     * This is a lock-free read from the active in-memory lookup.
     * @param {NodeIdentifier} nodeIdentifier
     * @returns {import('./types').NodeKeyString | undefined}
     */
    lookupNodeKey(nodeIdentifier) {
        return nodeIdToKeyFromLookup(getActiveLookup(this.rootDatabase), nodeIdentifier);
    }

    /**
     * Look up the identifier for a given semantic node key.
     * This is a lock-free read from the active in-memory lookup.
     * @param {import('./types').NodeKeyString} nodeKey
     * @returns {NodeIdentifier | undefined}
     */
    lookupNodeIdentifier(nodeKey) {
        return nodeKeyToIdFromLookup(getActiveLookup(this.rootDatabase), nodeKey);
    }

    /**
     * @template T
     * @param {(batch: BatchBuilder, identifierResolver: IdentifierResolver) => Promise<T>} procedure
     * @returns {Promise<T>}
     */
    async withIdentifierBatch(procedure) {
        return this.storage.withIdentifierBatch(procedure);
    }

    /**
     * @param {PullContext} context
     * @returns {void}
     */
    pushActivePullContext(context) {
        const ownerAsyncId = executionAsyncId();
        const frame = {
            ...context,
            ownerAsyncIds: new Set(),
        };
        addFrameAsyncOwnership(ownerAsyncId, frame);
        this._activePullContexts.push(frame);
        activePullContextFrames.add(frame);
    }

    /**
     * @returns {PullContext | null}
     */
    getActivePullContext() {
        const currentAsyncId = executionAsyncId();
        for (let index = this._activePullContexts.length - 1; index >= 0; index--) {
            const current = this._activePullContexts[index];
            if (current === undefined) {
                continue;
            }
            if (current.ownerAsyncIds.has(currentAsyncId)) {
                return {
                    identifierResolver: current.identifierResolver,
                    batch: current.batch,
                };
            }
        }
        return null;
    }

    /**
     * @param {PullContext} context
     * @returns {void}
     */
    popActivePullContext(context) {
        // Locate the frame by identity rather than assuming LIFO order.
        // Nested pulls launched concurrently (e.g. via Promise.all inside a
        // computor) can complete in any order, so the frame to remove may not
        // be at the top of the stack. The search is O(n) in the number of
        // active contexts, which is bounded by the nesting depth and is
        // expected to remain very small in practice.
        const index = this._activePullContexts.findIndex(
            (frame) =>
                frame.identifierResolver === context.identifierResolver &&
                frame.batch === context.batch
        );
        if (index === -1) {
            throw new Error("Invalid pull context stack");
        }
        const frame = this._activePullContexts[index];
        for (const asyncId of frame.ownerAsyncIds) {
            const frames = pullContextFramesByAsyncId.get(asyncId);
            if (frames === undefined) {
                continue;
            }
            frames.delete(frame);
            if (frames.size === 0) {
                pullContextFramesByAsyncId.delete(asyncId);
            }
        }
        activePullContextFrames.delete(frame);
        this._activePullContexts.splice(index, 1);
    }

    /**
     * @param {ConcreteNode} concreteNode
     * @param {IdentifierResolver} identifierResolver
     * @returns {ResolvedConcreteNode}
     */
    resolveConcreteNode(concreteNode, identifierResolver) {
        return {
            outputKey: concreteNode.output,
            inputKeys: concreteNode.inputs,
            outputIdentifier: identifierResolver.getOrAllocateNodeIdentifier(
                concreteNode.output
            ),
            inputIdentifiers: concreteNode.inputs.map((inputKey) =>
                identifierResolver.getOrAllocateNodeIdentifier(inputKey)
            ),
            computor: concreteNode.computor,
        };
    }

    /**
     * @param {ResolvedConcreteNode} nodeDefinition
     * @param {BatchBuilder} batch
     * @param {IdentifierResolver} identifierResolver
     * @returns {Promise<RecomputeResult>}
     */
    async maybeRecalculate(nodeDefinition, batch, identifierResolver) {
        return await internalMaybeRecalculate(
            this,
            nodeDefinition,
            batch,
            identifierResolver
        );
    }

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} bindings
     * @returns {Promise<ComputedValue>}
     */
    async unsafePull(nodeName, bindings) {
        return await internalUnsafePull(this, nodeName, bindings);
    }

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<ComputedValue>}
     */
    async pull(nodeName, bindings = []) {
        return await internalPull(this, nodeName, bindings);
    }

    /**
     * @param {import('./types').NodeName} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<RecomputeResult>}
     */
    async pullWithStatus(nodeName, bindings = []) {
        return await internalSafePullWithStatus(this, nodeName, bindings);
    }

    /**
     * @param {NodeKeyString} nodeKeyStr
     * @param {IdentifierResolver} identifierResolver
     * @param {BatchBuilder | null} [outerBatch=null]
     * @returns {Promise<RecomputeResult>}
     */
    async _pullDuringPull(nodeKeyStr, identifierResolver, outerBatch = null) {
        return await internalPullByNodeKeyWithStatusDuringPull(
            this,
            nodeKeyStr,
            identifierResolver,
            outerBatch
        );
    }

    /**
     * @param {string} head
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<"up-to-date" | "potentially-outdated" | "missing">}
     */
    async getFreshness(head, bindings = []) {
        return await internalGetFreshness(this, head, bindings);
    }

    /**
     * @param {string} head
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<ComputedValue | undefined>}
     */
    async getValue(head, bindings = []) {
        return await internalGetValue(this, head, bindings);
    }

    /** @returns {Array<CompiledNode>} */
    getSchemas() {
        return internalGetSchemas(this);
    }

    /**
     * @param {string} head
     * @returns {CompiledNode | null}
     */
    getSchemaByHead(head) {
        return internalGetSchemaByHead(this, head);
    }

    /** @returns {Promise<Array<[string, Array<ConstValue>]>>} */
    async listMaterializedNodes() {
        return await internalListMaterializedNodes(this);
    }

    /** @returns {string} */
    getDbVersion() {
        return internalGetDbVersion(this);
    }

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<DateTime>}
     */
    async getCreationTime(nodeName, bindings = []) {
        return await internalGetCreationTime(this, nodeName, bindings);
    }

    /**
     * @param {string} nodeName
     * @param {Array<ConstValue>} [bindings=[]]
     * @returns {Promise<DateTime>}
     */
    async getModificationTime(nodeName, bindings = []) {
        return await internalGetModificationTime(this, nodeName, bindings);
    }
}

/**
 * @param {IncrementalGraphCapabilities} capabilities
 * @param {RootDatabase} rootDatabase
 * @param {Array<NodeDef>} nodeDefs
 * @returns {IncrementalGraphClass}
 */
function makeIncrementalGraph(capabilities, rootDatabase, nodeDefs) {
    return new IncrementalGraphClass(capabilities, rootDatabase, nodeDefs);
}

/**
 * @param {unknown} object
 * @returns {object is IncrementalGraphClass}
 */
function isIncrementalGraph(object) {
    return object instanceof IncrementalGraphClass;
}

/** @typedef {IncrementalGraphClass} IncrementalGraph */

module.exports = {
    makeIncrementalGraph,
    isIncrementalGraph,
};
