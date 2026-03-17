/** @typedef {import('../../event').Event} Event */

const { extractHashtags, isContextEnhancing, getType } = require("../../event");

/**
 * Returns the type of an event, or null if the event's input cannot be parsed.
 * @param {Event} otherEvent
 * @returns {string | null}
 */
function tryGetType(otherEvent) {
    try {
        return getType(otherEvent);
    } catch (_error) {
        return null;
    }
}

/**
 * This function extracts the basic context of a given event from a list of all events.
 *
 * @param {Array<Event>} all_events
 * @param {Event} event
 * @returns {Array<Event>} The context of the given event
 */
function getEventBasicContext(all_events, event) {
    const eventHashtags = extractHashtags(event);

    const context = all_events.filter((otherEvent) => {
        if (otherEvent.id === event.id) {
            return true; // Always include the event itself
        }

        // Check if event type is context-enhancing.
        // Use tryGetType to avoid crashing when an event's input cannot be parsed.
        const type = tryGetType(otherEvent);
        if (type === null || !isContextEnhancing(type)) {
            return false;
        }

        // Check if event contains some of the same hashtags
        const otherHashtags = extractHashtags(otherEvent);
        for (const hashtag of otherHashtags) {
            if (eventHashtags.has(hashtag)) {
                return true;
            }
        }

        return false;
    });

    return context;
}

module.exports = {
    getEventBasicContext,
};
