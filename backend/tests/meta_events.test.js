/**
 * Tests for generators/individual/meta_events module.
 */

const {
    computeMetaEvents,
    reconstructFromMetaEvents,
} = require("../src/generators/individual/meta_events");
const eventId = require("../src/event/id");
const { isUnchanged } = require("../src/generators/incremental_graph");
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

describe("generators/individual/meta_events", () => {
    describe("reconstructFromMetaEvents()", () => {
        test("reconstructs empty state from empty meta events", () => {
            const metaEvents = [];
            const reconstructed = reconstructFromMetaEvents(metaEvents);
            expect(reconstructed.size).toBe(0);
        });

        test("reconstructs state from add actions", () => {
            const metaEvents = [
                { action: "add", event: makeEvent("1", "test First event") },
                { action: "add", event: makeEvent("2", "test Second event", "2024-01-02") },
            ];

            const reconstructed = reconstructFromMetaEvents(metaEvents);
            expect(reconstructed.size).toBe(2);
            expect(getDescription(reconstructed.get("1"))).toBe("First event");
            expect(getDescription(reconstructed.get("2"))).toBe("Second event");
        });

        test("reconstructs state with delete actions", () => {
            const metaEvents = [
                { action: "add", event: makeEvent("1", "test First event") },
                { action: "delete", event: makeEvent("1", "test First event") },
            ];

            const reconstructed = reconstructFromMetaEvents(metaEvents);
            expect(reconstructed.size).toBe(0);
        });

        test("reconstructs state with edit actions", () => {
            const metaEvents = [
                { action: "add", event: makeEvent("1", "test First event") },
                { action: "edit", event: makeEvent("1", "test Updated event") },
            ];

            const reconstructed = reconstructFromMetaEvents(metaEvents);
            expect(reconstructed.size).toBe(1);
            expect(getDescription(reconstructed.get("1"))).toBe("Updated event");
        });
    });

    describe("computeMetaEvents()", () => {
        test("returns empty meta events for empty all_events and empty current meta events", () => {
            const allEvents = [];
            const currentMetaEvents = [];

            const result = computeMetaEvents(allEvents, currentMetaEvents);
            expect(isUnchanged(result)).toBe(true);
        });

        test("adds new event when all_events has an event not in current meta events", () => {
            const allEvents = [
                makeEvent("1", "test foo"),
                makeEvent("2", "test bar", "2024-01-02"),
            ];

            const currentMetaEvents = [
                { action: "add", event: makeEvent("1", "test foo") },
            ];

            const result = computeMetaEvents(allEvents, currentMetaEvents);

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual(currentMetaEvents[0]);
            expect(result[1].action).toBe("add");
            expect(eventId.toString(result[1].event.id)).toBe("2");
            expect(getDescription(result[1].event)).toBe("bar");
        });

        test("deletes event when current meta events has event not in all_events", () => {
            const allEvents = [
                makeEvent("1", "test foo"),
            ];

            const currentMetaEvents = [
                { action: "add", event: makeEvent("1", "test foo") },
                { action: "add", event: makeEvent("2", "test bar", "2024-01-02") },
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
                makeEvent("1", "test updated foo"),
            ];

            const currentMetaEvents = [
                { action: "add", event: makeEvent("1", "test foo") },
            ];

            const result = computeMetaEvents(allEvents, currentMetaEvents);

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual(currentMetaEvents[0]);
            expect(result[1].action).toBe("edit");
            expect(eventId.toString(result[1].event.id)).toBe("1");
            expect(getDescription(result[1].event)).toBe("updated foo");
        });

        test("handles complex scenario with add, delete, and edit", () => {
            const allEvents = [
                // Event 1: unchanged
                makeEvent("1", "test foo"),
                // Event 2: modified
                makeEvent("2", "test updated bar", "2024-01-02"),
                // Event 4: new
                makeEvent("4", "test new event", "2024-01-04"),
            ];

            const currentMetaEvents = [
                { action: "add", event: makeEvent("1", "test foo") },
                { action: "add", event: makeEvent("2", "test bar", "2024-01-02") },
                { action: "add", event: makeEvent("3", "test deleted event", "2024-01-03") },
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
            expect(getDescription(editAction?.event)).toBe("updated bar");

            // Find the add action for event 4
            const addAction = result.find(
                (me) => me.action === "add" && eventId.toString(me.event.id) === "4"
            );
            expect(addAction).toBeDefined();
            expect(getDescription(addAction?.event)).toBe("new event");

            // Find the delete action for event 3
            const deleteAction = result.find(
                (me) => me.action === "delete" && eventId.toString(me.event.id) === "3"
            );
            expect(deleteAction).toBeDefined();
            expect(getDescription(deleteAction?.event)).toBe("deleted event");
        });

        test("no changes when all_events matches reconstructed state", () => {
            const allEvents = [
                makeEvent("1", "test foo"),
            ];

            const currentMetaEvents = [
                { action: "add", event: makeEvent("1", "test foo") },
            ];

            const result = computeMetaEvents(allEvents, currentMetaEvents);

            expect(isUnchanged(result)).toBe(true);
        });
    });
});
