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
         * @param {string} key
         * @param {any} value
         */
        async put(key, value) {
            if (isFreshness(value)) {
                await storage.freshness.put(key, value);
            } else {
                await storage.values.put(key, value);
            }
        },
        
        /**
         * Delete a value. Tries both databases.
         * @param {string} key
         */
        async del(key) {
            try {
                await storage.values.del(key);
            } catch (e) {
                // Ignore if not found
            }
            try {
                await storage.freshness.del(key);
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
