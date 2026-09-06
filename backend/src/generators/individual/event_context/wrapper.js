const { computeEventContexts } = require('./compute');
const { eventToPersistedEvent, persistedEventToEvent } = require('../persisted_event');

/**
 * @type {import('../../incremental_graph/types').NodeDefComputor}
 */
const computor = async (inputs, _oldValue, _bindings) => {
    const metaEventsEntry = inputs[0];
    if (!metaEventsEntry) {
        return { type: "event_context", contexts: [] };
    }

    if (metaEventsEntry.type !== "meta_events") {
        return { type: "event_context", contexts: [] };
    }

    const metaEventsArray = metaEventsEntry.meta_events.map(metaEvent => ({
        action: metaEvent.action,
        event: persistedEventToEvent(metaEvent.event),
    }));
    const contexts = computeEventContexts(metaEventsArray);
    const serializedContexts = contexts.map(context => ({
        eventId: context.eventId,
        context: context.context.map(eventToPersistedEvent),
    }));

    return {
        type: "event_context",
        contexts: serializedContexts,
    };
};

module.exports = {
    computor,
};
