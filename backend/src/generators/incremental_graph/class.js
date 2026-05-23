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
 * @typedef {PullContext & { ownerAsyncId: number }} PullContextFrame
 */

/** @type {Map<number, number>} */
const asyncParentById = new Map();
createHook({
    init(asyncId, _type, triggerAsyncId) {
        asyncParentById.set(asyncId, triggerAsyncId);
    },
}).enable();

/**
 * @param {number} asyncId
 * @param {number} ancestorAsyncId
 * @returns {boolean}
 */
function isAsyncDescendantOf(asyncId, ancestorAsyncId) {
    let current = asyncId;
    const visited = new Set();
    while (!visited.has(current)) {
        if (current === ancestorAsyncId) {
            return true;
        }
        visited.add(current);
        const parent = asyncParentById.get(current);
        if (parent === undefined || parent === current) {
            return false;
        }
        current = parent;
    }
    return false;
}

const {
    compileNodeDef,
    validateAcyclic,
    validateInputArities,
    validateNoOverlap,
    validateSingleArityPerHead,
} = require("./compiled_node");
const { makeGraphStorage } = require("./graph_storage");
const { makeIdentifierResolver } = require("./identifier_resolver");
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

    /** @returns {IdentifierResolver} */
    makeIdentifierResolver() {
        return makeIdentifierResolver(this.rootDatabase);
    }

    /**
     * @param {IdentifierResolver} identifierResolver
     * @template T
     * @param {(batch: BatchBuilder) => Promise<T>} procedure
     * @returns {Promise<T>}
     */
    async withIdentifierBatch(identifierResolver, procedure) {
        return this.storage.withIdentifierBatch(identifierResolver, procedure);
    }

    /**
     * @param {PullContext} context
     * @returns {void}
     */
    pushActivePullContext(context) {
        this._activePullContexts.push({
            ...context,
            ownerAsyncId: executionAsyncId(),
        });
    }

    /**
     * @returns {PullContext | null}
     */
    getActivePullContext() {
        const currentAsyncId = executionAsyncId();
        for (let index = this._activePullContexts.length - 1; index >= 0; index--) {
            const current = this._activePullContexts[index];
            if (
                current !== undefined &&
                isAsyncDescendantOf(currentAsyncId, current.ownerAsyncId)
            ) {
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
        const current = this._activePullContexts[this._activePullContexts.length - 1];
        if (
            current === undefined ||
            current.identifierResolver !== context.identifierResolver ||
            current.batch !== context.batch
        ) {
            throw new Error("Invalid pull context stack");
        }
        this._activePullContexts.pop();
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
