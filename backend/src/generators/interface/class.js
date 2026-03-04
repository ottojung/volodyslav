/**
 * Interface class for direct database operations.
 */

/** @typedef {import('../incremental_graph/database/root_database').RootDatabase} RootDatabase */
/** @typedef {import('../../event').Event} Event */
/** @typedef {import('../incremental_graph').IncrementalGraph} IncrementalGraph */
/** @typedef {import('./types').GeneratorsCapabilities} GeneratorsCapabilities */
/** @typedef {import('../incremental_graph/database/types').AllEventsEntry} AllEventsEntry */

const {
    makeIncrementalGraph,
    getRootDatabase,
    runMigration,
    checkpointDatabase,
} = require("../incremental_graph");
const {
    createDefaultGraphDefinition,
    createDefaultMigrationCallback,
} = require("./default_graph");

/**
 * Mutable box that holds the current events value.
 * Created before node defs so the getter closure is valid both during
 * migration (node defs are only inspected for schema shape, not evaluated)
 * and at runtime (called by the all_events computor on each pull).
 * @typedef {{ current: AllEventsEntry }} EventsBox
 */

/**
 * An interface for direct database operations.
 * Provides methods to update the database with events.
 */
class InterfaceClass {
    /**
     * The incremental graph for propagating changes.
     * @type {IncrementalGraph}
     */
    incrementalGraph;

    /**
     * Mutable box holding the current events value.
     * @private
     * @type {EventsBox}
     */
    eventsBox;

    /**
     * @constructor
     * @param {RootDatabase} database - The root database instance
     * @param {import('../incremental_graph/types').NodeDef[]} nodeDefs - Pre-built node definitions
     * @param {EventsBox} eventsBox - Mutable events box shared with the node defs getter
     */
    constructor(database, nodeDefs, eventsBox) {
        this.eventsBox = eventsBox;
        this.incrementalGraph = makeIncrementalGraph(database, nodeDefs);
    }

    /**
     * Updates the all_events field in the database with the provided events.
     * Sets freshness to "dirty" and marks all dependents as "potentially-dirty".
     * @param {Array<Event>} all_events - Array of events to store
     * @returns {Promise<void>}
     */
    async update(all_events) {
        this.eventsBox.current = { events: all_events, type: "all_events" };
        await this.incrementalGraph.invalidate("all_events");
    }

    /**
     * Gets the basic context for a given event.
     * This method uses pull semantics to lazily evaluate only the necessary
     * parts of the incremental graph to get the event context.
     *
     * @param {Event} event - The event to get context for
     * @returns {Promise<Array<Event>>} The context events
     */
    async getEventBasicContext(event) {
        // Pull the event_context node (lazy evaluation)
        const eventContextEntry = await this.incrementalGraph.pull(
            "event_context"
        );

        if (!eventContextEntry || eventContextEntry.type !== "event_context") {
            return [event];
        }

        // Find the context for this specific event
        const contexts = eventContextEntry.contexts;
        const eventIdStr = event.id.identifier;
        const contextEntry = contexts.find((ctx) => ctx.eventId === eventIdStr);

        if (!contextEntry) {
            return [event];
        }

        return contextEntry.context;
    }
}

/**
 * Factory function to create an Interface instance.
 *
 * Boot sequence:
 * 1. Open the database via the gitstore-aware path.
 * 2. Build the events box and node defs.  The node defs carry a live getter
 *    over `eventsBox.current` so they are valid both during the migration
 *    schema-compatibility check and at normal-operation pull time.
 * 3. Run migration.  Fresh database → records version and returns
 *    immediately.  Same version → returns immediately.  Version change →
 *    pre-checkpoint, apply decisions, post-checkpoint.
 * 4. Construct InterfaceClass, which builds IncrementalGraph against the
 *    now-current x-namespace data.
 *
 * @param {GeneratorsCapabilities} capabilities
 * @returns {Promise<InterfaceClass>}
 */
async function makeInterface(capabilities) {
    // Step 1: open the database via the gitstore-aware path.
    const database = await getRootDatabase(capabilities);

    // Step 2: build events box and node defs before migration so the
    // migration runner can inspect the new schema's head index.
    /** @type {EventsBox} */
    const eventsBox = { current: { events: [], type: "all_events" } };
    const nodeDefs = createDefaultGraphDefinition(() => eventsBox.current);

    // Step 3: run migration (no-op on fresh/same version).
    const migrationCapabilities = {
        sleeper: capabilities.sleeper,
        checkpointDatabase: (/** @type {string} */ message) => checkpointDatabase(capabilities, message),
    };
    await runMigration(migrationCapabilities, database, nodeDefs, createDefaultMigrationCallback());

    // Step 4: construct the interface now that x-namespace holds the
    // correct version's data.
    return new InterfaceClass(database, nodeDefs, eventsBox);
}

/**
 * Type guard for Interface.
 * @param {unknown} object
 * @returns {object is InterfaceClass}
 */
function isInterface(object) {
    return object instanceof InterfaceClass;
}

/** @typedef {InterfaceClass} Interface */

/**
 * Capability wrapper for the incremental graph interface.
 * Created synchronously alongside all other capabilities; async initialisation
 * is deferred until ensureInitialized() is called from ensureStartupDependencies.
 */
class InterfaceCapabilityClass {
    /**
     * @private
     * @type {InterfaceClass | null}
     */
    _inner;

    constructor() {
        this._inner = null;
    }

    /**
     * Opens the database and runs any pending migration.
     * Idempotent — subsequent calls are no-ops.
     * @param {GeneratorsCapabilities} capabilities
     * @returns {Promise<void>}
     */
    async ensureInitialized(capabilities) {
        if (this._inner !== null) {
            return;
        }
        this._inner = await makeInterface(capabilities);
    }

    /**
     * Updates the all_events node and propagates staleness.
     * @param {Array<Event>} all_events
     * @returns {Promise<void>}
     */
    async update(all_events) {
        if (this._inner === null) {
            throw new Error("InterfaceCapability: ensureInitialized() must be called before update()");
        }
        return this._inner.update(all_events);
    }

    /**
     * Returns the basic context for a given event.
     * @param {Event} event
     * @returns {Promise<Array<Event>>}
     */
    async getEventBasicContext(event) {
        if (this._inner === null) {
            throw new Error("InterfaceCapability: ensureInitialized() must be called before getEventBasicContext()");
        }
        return this._inner.getEventBasicContext(event);
    }
}

/**
 * Creates an InterfaceCapability instance synchronously.
 * Call ensureInitialized() before any other method.
 * @returns {InterfaceCapabilityClass}
 */
function makeInterfaceCapability() {
    return new InterfaceCapabilityClass();
}

/**
 * @param {unknown} object
 * @returns {object is InterfaceCapabilityClass}
 */
function isInterfaceCapability(object) {
    return object instanceof InterfaceCapabilityClass;
}

/** @typedef {InterfaceCapabilityClass} InterfaceCapability */

module.exports = {
    makeInterface,
    isInterface,
    makeInterfaceCapability,
    isInterfaceCapability,
};
