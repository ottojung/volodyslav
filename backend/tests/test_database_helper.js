/**
 * Test helper to create a compatibility database interface.
 * This helps tests transition from old db.put() pattern to new storage pattern.
 * 
 * Usage:
 *   const db = await getRootDatabase(capabilities);
 *   const graphDef = [..];
 *   const graph = makeDependencyGraph(db, graphDef);
 *   const testDb = makeTestDatabase(graph);
 *   
 *   // Now use old pattern:
 *   await testDb.put("key", value);  // stores to storage.values
 *   await testDb.put("key", "up-to-date");  // stores to storage.freshness
 */

const { isFreshness } = require('../src/generators/database');
const { createNodeKeyFromPattern, serializeNodeKey } = require('../src/generators/dependency_graph/node_key');
const { canonicalize } = require('../src/generators/dependency_graph/expr');
const { isJsonKey } = require('./test_json_key_helper');

/**
 * Converts a node name to JSON key format if needed.
 * @param {string} key
 * @returns {string}
 */
function toJsonKey(key) {
    // If already a valid JSON key, return as-is
    if (isJsonKey(key)) {
        return key;
    }
    const canonical = canonicalize(key);
    const nodeKey = createNodeKeyFromPattern(canonical, {});
    return serializeNodeKey(nodeKey);
}

/**
 * Create a test database interface that mimics the old Database class.
 * @param {import('../src/generators/dependency_graph').DependencyGraph} graph
 * @returns {{put: (key: string, value: any) => Promise<void>, del: (key: string) => Promise<void>}}
 */
function makeTestDatabase(graph) {
    const storage = graph.getStorage();
    
    return {
        /**
         * Put a value. Automatically routes to values or freshness database based on type.
         * Automatically converts node names to JSON key format.
         * @param {string} key
         * @param {any} value
         */
        async put(key, value) {
            const jsonKey = toJsonKey(key);
            if (isFreshness(value)) {
                await storage.freshness.put(jsonKey, value);
            } else {
                await storage.values.put(jsonKey, value);
            }
        },
        
        /**
         * Delete a value. Tries both databases.
         * Automatically converts node names to JSON key format.
         * @param {string} key
         */
        async del(key) {
            const jsonKey = toJsonKey(key);
            try {
                await storage.values.del(jsonKey);
            } catch (e) {
                // Ignore if not found
            }
            try {
                await storage.freshness.del(jsonKey);
            } catch (e) {
                // Ignore if not found
            }
        }
    };
}

/**
 * freshnessKey is no longer needed with the new design.
 * This function now just returns the key unchanged.
 * Tests using freshnessKey("key") will pass "key" to put() with a Freshness value,
 * which makeTestDatabase() will correctly route to the freshness database.
 * @param {string} key
 * @returns {string}
 * @deprecated Use storage.freshness.put() directly instead
 */
function freshnessKey(key) {
    return key;
}

module.exports = {
    makeTestDatabase,
    freshnessKey,
};
