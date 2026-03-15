/**
 * Tests for generators/individual/event_context module.
 */

const {
    computeEventContexts,
    reconstructEventsFromMetaEvents,
} = require("../src/generators/individual/event_context");
const eventId = require("../src/event/id");
const { getDescription } = require("../src/event/computed");

/**
 * Helper to create a minimal Event object for testing.
 * @param {string} id
 * @param {string} input
 * @param {string} [date]
 * @returns {import('../src/event').Event}
 */
function makeEvent(id, input, date = "2024-01-01") {
    return {
        id: eventId.fromString(id),
        date,
        original: input,
        input,
        creator: { name: "test" },
    };
}

describe("generators/individual/event_context", () => {
    describe("reconstructEventsFromMetaEvents()", () => {
        test("reconstructs events from add actions", () => {
            const metaEvents = [
                { action: "add", event: makeEvent("1", "note First #project event") },
                { action: "add", event: makeEvent("2", "note Second #project event", "2024-01-02") },
            ];

            const events = reconstructEventsFromMetaEvents(metaEvents);
            expect(events).toHaveLength(2);
            expect(eventId.toString(events[0].id)).toBe("1");
            expect(eventId.toString(events[1].id)).toBe("2");
        });

        test("handles delete actions", () => {
            const metaEvents = [
                { action: "add", event: makeEvent("1", "note First event") },
                { action: "delete", event: makeEvent("1", "note First event") },
            ];

            const events = reconstructEventsFromMetaEvents(metaEvents);
            expect(events).toHaveLength(0);
        });

        test("handles edit actions", () => {
            const metaEvents = [
                { action: "add", event: makeEvent("1", "text Original") },
                { action: "edit", event: makeEvent("1", "text Updated") },
            ];

            const events = reconstructEventsFromMetaEvents(metaEvents);
            expect(events).toHaveLength(1);
            expect(getDescription(events[0])).toBe("Updated");
        });
    });

    describe("computeEventContexts()", () => {
        test("computes contexts for events with shared hashtags", () => {
            const metaEvents = [
                { action: "add", event: makeEvent("1", "text First #project event") },
                { action: "add", event: makeEvent("2", "text Second #project event", "2024-01-02") },
                { action: "add", event: makeEvent("3", "text Unrelated #other event", "2024-01-03") },
            ];

            const contexts = computeEventContexts(metaEvents);
            expect(contexts).toHaveLength(3);

            // Event 1 context should include itself and event 2 (both have #project)
            const event1Context = contexts.find(ctx => ctx.eventId === "1");
            expect(event1Context).toBeDefined();
            expect(event1Context.context).toHaveLength(2);
            
            const event1ContextIds = event1Context.context.map(e => e.id.identifier);
            expect(event1ContextIds).toContain("1");
            expect(event1ContextIds).toContain("2");

            // Event 3 context should only include itself (different hashtag)
            const event3Context = contexts.find(ctx => ctx.eventId === "3");
            expect(event3Context).toBeDefined();
            expect(event3Context.context).toHaveLength(1);
            expect(event3Context.context[0].id.identifier).toBe("3");
        });

        test("returns empty array for empty meta events", () => {
            const contexts = computeEventContexts([]);
            expect(contexts).toHaveLength(0);
        });

        test("each event includes itself in context", () => {
            const metaEvents = [
                { action: "add", event: makeEvent("1", "text Event without hashtags") },
            ];

            const contexts = computeEventContexts(metaEvents);
            expect(contexts).toHaveLength(1);
            expect(contexts[0].eventId).toBe("1");
            expect(contexts[0].context).toHaveLength(1);
            expect(contexts[0].context[0].id.identifier).toBe("1");
        });
    });
});
