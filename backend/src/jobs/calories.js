/**
 * Calories computation job.
 *
 * Walks every event in all_events and pulls calories(e) for each one,
 * warming the incremental-graph cache so the values are available on demand.
 */

/** @typedef {import('../capabilities/root').Capabilities} Capabilities */

/**
 * Pulls the calorie estimate for every known event from the incremental graph.
 *
 * The incremental graph caches results, so re-running this job only triggers
 * AI calls for events whose input text has changed since the last run.
 *
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function computeAllCalories(capabilities) {
    const graph = capabilities.interface.incrementalGraph;
    if (graph === null) {
        capabilities.logger.logError({}, "computeAllCalories: incremental graph is not initialized");
        return;
    }

    const allEventsEntry = await graph.pull("all_events");
    if (!allEventsEntry || allEventsEntry.type !== "all_events") {
        capabilities.logger.logInfo({}, "computeAllCalories: no events found");
        return;
    }

    const events = allEventsEntry.events;
    capabilities.logger.logInfo({ count: events.length }, `computeAllCalories: computing calories for ${events.length} events`);

    let computed = 0;
    for (const event of events) {
        const eventId = String(
            event.id && event.id.identifier !== undefined ? event.id.identifier : event.id
        );
        await graph.pull("calories", [eventId]);
        computed += 1;
    }

    capabilities.logger.logInfo({ computed }, `computeAllCalories: done (${computed} events processed)`);
}

module.exports = {
    computeAllCalories,
};
