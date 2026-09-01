const { deserialize } = require('../../../event');
const { computeMetaEvents } = require('./compute');

/**
 * @type {import('../../incremental_graph/types').NodeDefComputor}
 */
const computor = async (inputs, oldValue, _bindings) => {
    const allEventsEntry = inputs[0];
    if (!allEventsEntry) {
        return { type: "meta_events", meta_events: [] };
    }

    if (allEventsEntry.type !== "all_events") {
        return { type: "meta_events", meta_events: [] };
    }

    const allEvents = allEventsEntry.events.map(deserialize);

    /** @type {Array<import('./compute').MetaEvent>} */
    let currentMetaEvents = [];
    /** @type {Array<import('../../incremental_graph/database/types').SerializedMetaEvent>} */
    let serializedCurrentMetaEvents = [];
    if (oldValue && oldValue.type === "meta_events") {
        serializedCurrentMetaEvents = oldValue.meta_events;
        currentMetaEvents = serializedCurrentMetaEvents.map(metaEvent => ({
            action: metaEvent.action,
            event: deserialize(metaEvent.event),
        }));
    }

    const result = computeMetaEvents(
        allEvents,
        currentMetaEvents
    );

    if (!Array.isArray(result)) {
        return oldValue === undefined
            ? { type: "meta_events", meta_events: serializedCurrentMetaEvents }
            : result;
    }

    const serializedById = new Map();
    for (const metaEvent of serializedCurrentMetaEvents) {
        serializedById.set(metaEvent.event.id, metaEvent.event);
    }
    for (const serializedEvent of allEventsEntry.events) {
        serializedById.set(serializedEvent.id, serializedEvent);
    }

    const serializedResult = result.map(metaEvent => {
            const serializedEvent = serializedById.get(metaEvent.event.id.identifier);
            if (serializedEvent === undefined) {
                throw new Error(`Missing serialized event ${metaEvent.event.id.identifier}`);
            }
            return { action: metaEvent.action, event: serializedEvent };
        });

    return {
        type: "meta_events",
        meta_events: serializedResult,
    };
};

module.exports = {
    computor,
};
