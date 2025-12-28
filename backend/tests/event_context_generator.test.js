/**
 * Tests for generators/individual/event_context module.
 */

const {
    computeEventContexts,
    reconstructEventsFromMetaEvents,
} = require("../src/generators/individual/event_context");
const eventId = require("../src/event/id");

describe("generators/individual/event_context", () => {
    describe("reconstructEventsFromMetaEvents()", () => {
        test("reconstructs events from add actions", () => {
            const metaEvents = [
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("1"),
                        type: "note",
                        description: "First #project event",
                        date: "2024-01-01",
                        original: "test1",
                        input: "test1",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("2"),
                        type: "note",
                        description: "Second #project event",
                        date: "2024-01-02",
                        original: "test2",
                        input: "test2",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
            ];

            const events = reconstructEventsFromMetaEvents(metaEvents);
            expect(events).toHaveLength(2);
            expect(eventId.toString(events[0].id)).toBe("1");
            expect(eventId.toString(events[1].id)).toBe("2");
        });

        test("handles delete actions", () => {
            const metaEvents = [
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("1"),
                        type: "note",
                        description: "First event",
                        date: "2024-01-01",
                        original: "test1",
                        input: "test1",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
                {
                    action: "delete",
                    event: {
                        id: eventId.fromString("1"),
                        type: "note",
                        description: "First event",
                        date: "2024-01-01",
                        original: "test1",
                        input: "test1",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
            ];

            const events = reconstructEventsFromMetaEvents(metaEvents);
            expect(events).toHaveLength(0);
        });

        test("handles edit actions", () => {
            const metaEvents = [
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("1"),
                        type: "text",
                        description: "Original",
                        date: "2024-01-01",
                        original: "test1",
                        input: "test1",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
                {
                    action: "edit",
                    event: {
                        id: eventId.fromString("1"),
                        type: "text",
                        description: "Updated",
                        date: "2024-01-01",
                        original: "test1",
                        input: "test1",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
            ];

            const events = reconstructEventsFromMetaEvents(metaEvents);
            expect(events).toHaveLength(1);
            expect(events[0].description).toBe("Updated");
        });
    });

    describe("computeEventContexts()", () => {
        test("computes contexts for events with shared hashtags", () => {
            const metaEvents = [
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("1"),
                        type: "text",
                        description: "First #project event",
                        date: "2024-01-01",
                        original: "First #project event",
                        input: "First #project event",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("2"),
                        type: "text",
                        description: "Second #project event",
                        date: "2024-01-02",
                        original: "Second #project event",
                        input: "Second #project event",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("3"),
                        type: "text",
                        description: "Unrelated #other event",
                        date: "2024-01-03",
                        original: "Unrelated #other event",
                        input: "Unrelated #other event",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
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
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("1"),
                        type: "text",
                        description: "Event without hashtags",
                        date: "2024-01-01",
                        original: "test1",
                        input: "test1",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
            ];

            const contexts = computeEventContexts(metaEvents);
            expect(contexts).toHaveLength(1);
            expect(contexts[0].eventId).toBe("1");
            expect(contexts[0].context).toHaveLength(1);
            expect(contexts[0].context[0].id.identifier).toBe("1");
        });
    });
});
