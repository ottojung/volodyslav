/**
 * LRU cache wrapper for concrete node instantiations.
 * Provides bounded memory usage for caching ConcreteNode instances.
 */

const { LRUCache } = require('lru-cache');

/** @typedef {import('./types').ConcreteNode} ConcreteNode */
/** @typedef {import('./types').NodeKeyString} NodeKeyString */

/**
 * Default maximum number of cached concrete instantiations.
 * This prevents unbounded memory growth in long-running processes.
 */
const DEFAULT_MAX_SIZE = 10000;

/**
 * LRU cache for concrete node instantiations.
 * @typedef {Object} ConcreteNodeCache
 * @property {(key: NodeKeyString) => ConcreteNode | undefined} get - Get a cached node
 * @property {(key: NodeKeyString, value: ConcreteNode) => void} set - Cache a node
 * @property {() => number} size - Get current cache size
 * @property {() => void} clear - Clear the cache
 */

/**
 * Internal cache class.
 * Not exported - use makeConcreteNodeCache factory instead.
 */
class ConcreteNodeCacheClass {
    /**
     * @private
     * @type {LRUCache<NodeKeyString, ConcreteNode>}
     */
    cache;

    /**
     * @param {number} maxSize - Maximum number of entries to cache
     */
    constructor(maxSize = DEFAULT_MAX_SIZE) {
        this.cache = new LRUCache({
            max: maxSize,
        });
    }

    /**
     * Get a cached concrete node.
     * @param {NodeKeyString} key - Node key
     * @returns {ConcreteNode | undefined}
     */
    get(key) {
        return this.cache.get(key);
    }

    /**
     * Cache a concrete node.
     * @param {NodeKeyString} key - Node key
     * @param {ConcreteNode} value - Concrete node to cache
     */
    set(key, value) {
        this.cache.set(key, value);
    }

    /**
     * Get current cache size.
     * @returns {number}
     */
    size() {
        return this.cache.size;
    }

    /**
     * Clear the cache.
     */
    clear() {
        this.cache.clear();
    }
}

/**
 * Factory function to create a concrete node cache.
 * @param {number} [maxSize] - Maximum number of entries to cache (default: 10000)
 * @returns {ConcreteNodeCache}
 */
function makeConcreteNodeCache(maxSize) {
    return new ConcreteNodeCacheClass(maxSize);
}

/**
 * Type guard for ConcreteNodeCache.
 * @param {unknown} object
 * @returns {object is ConcreteNodeCache}
 */
function isConcreteNodeCache(object) {
    return object instanceof ConcreteNodeCacheClass;
}

module.exports = {
    makeConcreteNodeCache,
    isConcreteNodeCache,
    DEFAULT_MAX_SIZE,
};
