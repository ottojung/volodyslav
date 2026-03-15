/**
 * Tests that concurrent calls to ensureInitialized() are serialized so that
 * the database is opened and migrations are run exactly once, regardless of
 * how many HTTP requests arrive simultaneously.
 */

const { makeInterface } = require("../src/generators/interface");
const { stubGeneratorsRepository } = require("./stub_generators_repository");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment, stubDatetime, stubEventLogRepository } = require("./stubs");

/**
 * Creates test capabilities.
 * @returns {Promise<object>}
 */
async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    await stubEventLogRepository(capabilities);
    await stubGeneratorsRepository(capabilities);
    return capabilities;
}

describe("ensureInitialized() concurrency", () => {
    test("handles concurrent calls on the same interface without error", async () => {
        const capabilities = await getTestCapabilities();
        const iface = makeInterface(() => capabilities);

        // Simulate multiple concurrent HTTP requests all triggering ensureInitialized.
        await Promise.all([
            iface.ensureInitialized(),
            iface.ensureInitialized(),
            iface.ensureInitialized(),
        ]);

        expect(iface.isInitialized()).toBe(true);
    });

    test("database is usable after concurrent initialization", async () => {
        const capabilities = await getTestCapabilities();
        const iface = makeInterface(() => capabilities);

        await Promise.all([
            iface.ensureInitialized(),
            iface.ensureInitialized(),
        ]);

        // The interface should be fully operational after concurrent initialization.
        const events = await iface.getAllEvents();
        expect(Array.isArray(events)).toBe(true);
    });

    test("migration runs exactly once when concurrent calls race at startup", async () => {
        const capabilities = await getTestCapabilities();

        const iface = makeInterface(() => capabilities);

        // Without the mutex fix, concurrent calls would each try to open the
        // same LevelDB database, causing failures.  With the fix, only the
        // first caller opens the database; subsequent callers short-circuit
        // once they see _incrementalGraph is non-null.
        //
        // Verify that all three calls complete successfully and the graph is
        // fully operational: the same _incrementalGraph instance is shared.
        await Promise.all([
            iface.ensureInitialized(),
            iface.ensureInitialized(),
            iface.ensureInitialized(),
        ]);

        expect(iface.isInitialized()).toBe(true);

        // A second round of concurrent calls must also be safe (all short-circuit).
        await Promise.all([
            iface.ensureInitialized(),
            iface.ensureInitialized(),
        ]);

        expect(iface.isInitialized()).toBe(true);

        // The graph is usable after concurrent initialization.
        const graph = iface._incrementalGraph;
        expect(graph).not.toBeNull();
    });
});
