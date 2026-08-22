const { computeEventContexts } = require('./compute');
const { deserialize } = require('../../../event');

class MissingSerializedContextEvent extends Error {
    /** @param {string} identifier */
    constructor(identifier) {
        super(`Missing serialized context event ${identifier}`);
        this.name = "MissingSerializedContextEventError";
        this.identifier = identifier;
    }
}

/**
 * @param {unknown} object
 * @returns {object is MissingSerializedContextEvent}
 */
function isMissingSerializedContextEvent(object) {
    return object instanceof MissingSerializedContextEvent;
}

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
    const serializedById = new Map();
    for (const metaEvent of metaEventsEntry.meta_events) {
        if (metaEvent.action === "delete") serializedById.delete(metaEvent.event.id);
        else serializedById.set(metaEvent.event.id, metaEvent.event);
    }

    return {
        type: "event_context",
        contexts: contexts.map(context => ({
            eventId: context.eventId,
            context: context.context.map(event => {
                const serialized = serializedById.get(event.id.identifier);
                if (serialized === undefined) {
                    throw new MissingSerializedContextEvent(event.id.identifier);
                }
                return serialized;
            }),
        })),
    };
};

module.exports = {
    computor,
    isMissingSerializedContextEvent,
};
