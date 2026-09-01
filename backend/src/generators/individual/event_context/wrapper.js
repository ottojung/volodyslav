const { computeEventContexts } = require('./compute');
const { deserialize } = require('../../../event');

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
        event: deserialize(metaEvent.event),
    }));
    const contexts = computeEventContexts(metaEventsArray);
    const serializedById = new Map(
        metaEventsEntry.meta_events.map(metaEvent => [
            metaEvent.event.id,
            metaEvent.event,
        ])
    );
    const serializedContexts = contexts.map(context => ({
        eventId: context.eventId,
        context: context.context.map(event => {
            const serialized = serializedById.get(event.id.identifier);
            if (serialized === undefined) {
                throw new Error(`Missing serialized event ${event.id.identifier}`);
            }
            return serialized;
        }),
    }));

    return {
        type: "event_context",
        contexts: serializedContexts,
    };
};

module.exports = {
    computor,
};
