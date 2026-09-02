const { deserialize } = require('../../../event');
const { computeMetaEvents } = require('./compute');
const { eventToPersistedEvent, persistedEventToEvent } = require('../persisted_event');

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
    /** @type {Array<import('../../incremental_graph/database/types').PersistedMetaEvent>} */
    let serializedCurrentMetaEvents = [];
    if (oldValue && oldValue.type === "meta_events") {
        serializedCurrentMetaEvents = oldValue.meta_events;
        currentMetaEvents = serializedCurrentMetaEvents.map(metaEvent => ({
            action: metaEvent.action,
            event: persistedEventToEvent(metaEvent.event),
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
        serializedById.set(metaEvent.event.id.identifier, metaEvent.event);
    }

    const serializedResult = result.map(metaEvent => {
            const persistedEvent = serializedById.get(metaEvent.event.id.identifier) ??
                eventToPersistedEvent(metaEvent.event);
            return { action: metaEvent.action, event: persistedEvent };
        });

    return {
        type: "meta_events",
        meta_events: serializedResult,
    };
};

module.exports = {
    computor,
};
