/**
 * Interface class for direct database operations.
 */

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
 * Created synchronously; call ensureInitialized() before using update() or
 * getEventBasicContext().  This mirrors the pattern used by other capabilities
 * such as checker and logger which also capture `() => Capabilities`.
 */
class InterfaceClass {
    /**
     * Getter for the capabilities object, captured at construction time.
     * @private
     * @type {() => GeneratorsCapabilities}
     */
    _getCapabilities;

    /**
     * The live incremental graph and events box, set after ensureInitialized().
     * @private
     * @type {{ incrementalGraph: IncrementalGraph, eventsBox: EventsBox } | null}
     */
    _inner;

    /**
     * @constructor
     * @param {() => GeneratorsCapabilities} getCapabilities - Lazy getter for capabilities
     */
    constructor(getCapabilities) {
        this._getCapabilities = getCapabilities;
        this._inner = null;
    }

    /**
     * Opens the database and runs any pending migration.
     * Idempotent — subsequent calls are no-ops.
     *
     * Boot sequence:
     * 1. Open the database via the gitstore-aware path.
     * 2. Build the events box and node defs.  The node defs carry a live getter
     *    over `eventsBox.current` so they are valid both during the migration
     *    schema-compatibility check and at normal-operation pull time.
     * 3. Run migration.  Fresh database → records version and returns
     *    immediately.  Same version → returns immediately.  Version change →
     *    pre-checkpoint, apply decisions, post-checkpoint.
     * 4. Wire up IncrementalGraph against the now-current x-namespace data.
     *
     * @returns {Promise<void>}
     */
    async ensureInitialized() {
        if (this._inner !== null) {
            return;
        }
        const capabilities = this._getCapabilities();

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

        // Step 4: wire up the incremental graph.
        const incrementalGraph = makeIncrementalGraph(database, nodeDefs);
        this._inner = { incrementalGraph, eventsBox };
    }

    /**
     * Updates the all_events field in the database with the provided events.
     * Sets freshness to "dirty" and marks all dependents as "potentially-dirty".
     * @param {Array<Event>} all_events - Array of events to store
     * @returns {Promise<void>}
     */
    async update(all_events) {
        if (this._inner === null) {
            throw new Error("Interface: ensureInitialized() must be called before update()");
        }
        this._inner.eventsBox.current = { events: all_events, type: "all_events" };
        await this._inner.incrementalGraph.invalidate("all_events");
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
        if (this._inner === null) {
            throw new Error("Interface: ensureInitialized() must be called before getEventBasicContext()");
        }
        // Pull the event_context node (lazy evaluation)
        const eventContextEntry = await this._inner.incrementalGraph.pull(
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
 * Synchronous — pass the lazy `() => GeneratorsCapabilities` getter captured
 * from the capabilities object, the same pattern used by checker and logger.
 * Call ensureInitialized() before using any other methods.
 *
 * @param {() => GeneratorsCapabilities} getCapabilities
 * @returns {InterfaceClass}
 */
function makeInterface(getCapabilities) {
    return new InterfaceClass(getCapabilities);
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

module.exports = {
    makeInterface,
    isInterface,
};
