const { isUnchanged } = require('../../incremental_graph');
const { deserialize } = require('../../../event');
const { computeMetaEvents } = require('./compute');

class MissingSerializedMetaEvent extends Error {
    /** @param {string} identifier */
    constructor(identifier) {
        super(`Missing serialized meta event ${identifier}`);
        this.name = "MissingSerializedMetaEventError";
        this.identifier = identifier;
    }
}

/**
 * @param {unknown} object
 * @returns {object is MissingSerializedMetaEvent}
 */
function isMissingSerializedMetaEvent(object) {
    return object instanceof MissingSerializedMetaEvent;
}

/**
 * @param {Map<string, import('../../../event').SerializedEvent>} events
 * @param {string} identifier
 * @returns {import('../../../event').SerializedEvent}
 */
function requireSerializedEvent(events, identifier) {
    const event = events.get(identifier);
    if (event === undefined) {
        throw new MissingSerializedMetaEvent(identifier);
    }
    return event;
}

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
    if (oldValue && oldValue.type === "meta_events") {
        currentMetaEvents = oldValue.meta_events.map(metaEvent => ({
            action: metaEvent.action,
            event: deserialize(metaEvent.event),
        }));
    }

    const result = computeMetaEvents(
        allEvents,
        currentMetaEvents
    );

    if (isUnchanged(result) && oldValue !== undefined) {
        return result;
    }

    const currentSerializedById = new Map(
        oldValue && oldValue.type === "meta_events"
            ? oldValue.meta_events.map(metaEvent => [metaEvent.event.id, metaEvent.event])
            : []
    );
    const nextSerializedById = new Map(allEventsEntry.events.map(event => [event.id, event]));
    const metaEvents = isUnchanged(result) ? currentMetaEvents : result;

    return {
        type: "meta_events",
        meta_events: metaEvents.map(metaEvent => ({
            action: metaEvent.action,
            event: requireSerializedEvent(
                metaEvent.action === "delete" ? currentSerializedById : nextSerializedById,
                metaEvent.event.id.identifier
            ),
        })),
    };
};

module.exports = {
    computor,
    isMissingSerializedMetaEvent,
};
