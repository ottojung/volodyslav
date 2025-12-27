/** @typedef {import('../../event').Event} Event */

const { extractHashtags, isContextEnhancing } = require("../../event");

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

        // Check if event type is context-enhancing
        if (!isContextEnhancing(otherEvent.type)) {
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
