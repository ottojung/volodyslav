/**
 * Tests for generators/individual/meta_events module.
 */

const {
    computeMetaEvents,
    reconstructFromMetaEvents,
} = require("../src/generators/individual/meta_events");
const eventId = require("../src/event/id");

describe("generators/individual/meta_events", () => {
    describe("reconstructFromMetaEvents()", () => {
        test("reconstructs empty state from empty meta events", () => {
            const metaEvents = [];
            const reconstructed = reconstructFromMetaEvents(metaEvents);
            expect(reconstructed.size).toBe(0);
        });

        test("reconstructs state from add actions", () => {
            const metaEvents = [
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("1"),
                        type: "test",
                        description: "First event",
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
                        type: "test",
                        description: "Second event",
                        date: "2024-01-02",
                        original: "test2",
                        input: "test2",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
            ];

            const reconstructed = reconstructFromMetaEvents(metaEvents);
            expect(reconstructed.size).toBe(2);
            expect(reconstructed.get("1")?.description).toBe("First event");
            expect(reconstructed.get("2")?.description).toBe("Second event");
        });

        test("reconstructs state with delete actions", () => {
            const metaEvents = [
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("1"),
                        type: "test",
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
                        type: "test",
                        description: "First event",
                        date: "2024-01-01",
                        original: "test1",
                        input: "test1",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
            ];

            const reconstructed = reconstructFromMetaEvents(metaEvents);
            expect(reconstructed.size).toBe(0);
        });

        test("reconstructs state with edit actions", () => {
            const metaEvents = [
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("1"),
                        type: "test",
                        description: "First event",
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
                        type: "test",
                        description: "Updated event",
                        date: "2024-01-01",
                        original: "test1",
                        input: "test1",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
            ];

            const reconstructed = reconstructFromMetaEvents(metaEvents);
            expect(reconstructed.size).toBe(1);
            expect(reconstructed.get("1")?.description).toBe("Updated event");
        });
    });

    describe("computeMetaEvents()", () => {
        test("returns empty meta events for empty all_events and empty current meta events", () => {
            const allEvents = [];
            const currentMetaEvents = [];

            const result = computeMetaEvents(allEvents, currentMetaEvents);
            expect(result).toEqual([]);
        });

        test("adds new event when all_events has an event not in current meta events", () => {
            const allEvents = [
                {
                    id: eventId.fromString("1"),
                    type: "test",
                    description: "foo",
                    date: "2024-01-01",
                    original: "foo",
                    input: "foo",
                    modifiers: {},
                    creator: { type: "user", name: "test" },
                },
                {
                    id: eventId.fromString("2"),
                    type: "test",
                    description: "bar",
                    date: "2024-01-02",
                    original: "bar",
                    input: "bar",
                    modifiers: {},
                    creator: { type: "user", name: "test" },
                },
            ];

            const currentMetaEvents = [
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("1"),
                        type: "test",
                        description: "foo",
                        date: "2024-01-01",
                        original: "foo",
                        input: "foo",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
            ];

            const result = computeMetaEvents(allEvents, currentMetaEvents);

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual(currentMetaEvents[0]);
            expect(result[1].action).toBe("add");
            expect(eventId.toString(result[1].event.id)).toBe("2");
            expect(result[1].event.description).toBe("bar");
        });

        test("deletes event when current meta events has event not in all_events", () => {
            const allEvents = [
                {
                    id: eventId.fromString("1"),
                    type: "test",
                    description: "foo",
                    date: "2024-01-01",
                    original: "foo",
                    input: "foo",
                    modifiers: {},
                    creator: { type: "user", name: "test" },
                },
            ];

            const currentMetaEvents = [
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("1"),
                        type: "test",
                        description: "foo",
                        date: "2024-01-01",
                        original: "foo",
                        input: "foo",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("2"),
                        type: "test",
                        description: "bar",
                        date: "2024-01-02",
                        original: "bar",
                        input: "bar",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
            ];

            const result = computeMetaEvents(allEvents, currentMetaEvents);

            expect(result).toHaveLength(3);
            expect(result[0]).toEqual(currentMetaEvents[0]);
            expect(result[1]).toEqual(currentMetaEvents[1]);
            expect(result[2].action).toBe("delete");
            expect(eventId.toString(result[2].event.id)).toBe("2");
        });

        test("edits event when event exists in both but with different properties", () => {
            const allEvents = [
                {
                    id: eventId.fromString("1"),
                    type: "test",
                    description: "updated foo",
                    date: "2024-01-01",
                    original: "foo",
                    input: "foo",
                    modifiers: {},
                    creator: { type: "user", name: "test" },
                },
            ];

            const currentMetaEvents = [
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("1"),
                        type: "test",
                        description: "foo",
                        date: "2024-01-01",
                        original: "foo",
                        input: "foo",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
            ];

            const result = computeMetaEvents(allEvents, currentMetaEvents);

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual(currentMetaEvents[0]);
            expect(result[1].action).toBe("edit");
            expect(eventId.toString(result[1].event.id)).toBe("1");
            expect(result[1].event.description).toBe("updated foo");
        });

        test("handles complex scenario with add, delete, and edit", () => {
            const allEvents = [
                // Event 1: unchanged
                {
                    id: eventId.fromString("1"),
                    type: "test",
                    description: "foo",
                    date: "2024-01-01",
                    original: "foo",
                    input: "foo",
                    modifiers: {},
                    creator: { type: "user", name: "test" },
                },
                // Event 2: modified
                {
                    id: eventId.fromString("2"),
                    type: "test",
                    description: "updated bar",
                    date: "2024-01-02",
                    original: "bar",
                    input: "bar",
                    modifiers: {},
                    creator: { type: "user", name: "test" },
                },
                // Event 4: new
                {
                    id: eventId.fromString("4"),
                    type: "test",
                    description: "new event",
                    date: "2024-01-04",
                    original: "new",
                    input: "new",
                    modifiers: {},
                    creator: { type: "user", name: "test" },
                },
            ];

            const currentMetaEvents = [
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("1"),
                        type: "test",
                        description: "foo",
                        date: "2024-01-01",
                        original: "foo",
                        input: "foo",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("2"),
                        type: "test",
                        description: "bar",
                        date: "2024-01-02",
                        original: "bar",
                        input: "bar",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("3"),
                        type: "test",
                        description: "deleted event",
                        date: "2024-01-03",
                        original: "del",
                        input: "del",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
            ];

            const result = computeMetaEvents(allEvents, currentMetaEvents);

            expect(result).toHaveLength(6);
            // First 3 are from current meta events (unchanged)
            expect(result[0]).toEqual(currentMetaEvents[0]);
            expect(result[1]).toEqual(currentMetaEvents[1]);
            expect(result[2]).toEqual(currentMetaEvents[2]);
            
            // Find the edit action for event 2
            const editAction = result.find(
                (me) => me.action === "edit" && eventId.toString(me.event.id) === "2"
            );
            expect(editAction).toBeDefined();
            expect(editAction?.event.description).toBe("updated bar");

            // Find the add action for event 4
            const addAction = result.find(
                (me) => me.action === "add" && eventId.toString(me.event.id) === "4"
            );
            expect(addAction).toBeDefined();
            expect(addAction?.event.description).toBe("new event");

            // Find the delete action for event 3
            const deleteAction = result.find(
                (me) => me.action === "delete" && eventId.toString(me.event.id) === "3"
            );
            expect(deleteAction).toBeDefined();
            expect(deleteAction?.event.description).toBe("deleted event");
        });

        test("no changes when all_events matches reconstructed state", () => {
            const allEvents = [
                {
                    id: eventId.fromString("1"),
                    type: "test",
                    description: "foo",
                    date: "2024-01-01",
                    original: "foo",
                    input: "foo",
                    modifiers: {},
                    creator: { type: "user", name: "test" },
                },
            ];

            const currentMetaEvents = [
                {
                    action: "add",
                    event: {
                        id: eventId.fromString("1"),
                        type: "test",
                        description: "foo",
                        date: "2024-01-01",
                        original: "foo",
                        input: "foo",
                        modifiers: {},
                        creator: { type: "user", name: "test" },
                    },
                },
            ];

            const result = computeMetaEvents(allEvents, currentMetaEvents);

            expect(result).toEqual(currentMetaEvents);
        });
    });
});
