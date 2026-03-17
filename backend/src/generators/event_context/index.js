/** @typedef {import('../../event').Event} Event */

const { extractHashtags, isContextEnhancing, getType } = require("../../event");

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
        // Some stored entries may have been created before the current parsing
        // rules were in place (e.g. descriptions containing bracket notation).
        // Treat those unparseable events as non-context-enhancing so a single
        // malformed entry cannot break calories computation for all events.
        let otherType;
        try {
            otherType = getType(otherEvent);
        } catch (error) {
            const body = JSON.stringify(otherEvent.input);
            throw new Error(`Failed to parse event type for event with id ${otherEvent.id} and body ${body}: ${String(error)}`);
        }

        if (!isContextEnhancing(otherType)) {
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
