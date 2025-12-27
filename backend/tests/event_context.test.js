const { getEventBasicContext } = require("../src/generators/event_context");
const { fromISOString, fromMinutes } = require("../src/datetime");

describe("getEventBasicContext", () => {
    const makeEvent = (id, input, date, type = "text") => ({
        id,
        input,
        date,
        type,
        original: input,
        modifiers: {},
        description: input,
        creator: { name: "test", uuid: "test-uuid", version: "1.0" },
    });

    it("returns empty array when event has no hashtags", () => {
        const date = fromISOString("2024-01-01T12:00:00.000Z");
        const targetEvent = makeEvent("target", "No hashtags", date);
        const allEvents = [
            makeEvent("1", "Earlier #work event", date),
            targetEvent,
        ];

        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toHaveLength(1);
        expect(context).toContain(targetEvent);
    });

    it("returns events with matching hashtags regardless of time", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));
        const date3 = date2.advance(fromMinutes(10));

        const event1 = makeEvent("1", "Earlier #work event", date1);
        const event2 = makeEvent("2", "Another #work task", date2);
        const targetEvent = makeEvent("target", "Current #work status", date3);

        const allEvents = [event1, event2, targetEvent];

        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toHaveLength(3);
        expect(context).toContain(event1);
        expect(context).toContain(event2);
        expect(context).toContain(targetEvent);
    });

    it("includes events regardless of time", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));
        const date3 = date2.advance(fromMinutes(10));

        const event1 = makeEvent("1", "Earlier #work event", date1);
        const targetEvent = makeEvent("target", "Current #work status", date2);
        const event3 = makeEvent("3", "Later #work event", date3);

        const allEvents = [event1, targetEvent, event3];

        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toHaveLength(3);
        expect(context).toContain(event1);
        expect(context).toContain(targetEvent);
        expect(context).toContain(event3);
    });

    it("excludes events that do not share hashtags", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const event1 = makeEvent("1", "Earlier #meeting event", date1);
        const targetEvent = makeEvent("target", "Current #work status", date2);

        const allEvents = [event1, targetEvent];

        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toHaveLength(1);
        expect(context).toContain(targetEvent);
    });

    it("includes the target event itself in context", () => {
        const date = fromISOString("2024-01-01T12:00:00.000Z");
        const targetEvent = makeEvent("target", "Current #work status", date);
        const allEvents = [targetEvent];

        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toHaveLength(1);
        expect(context).toContain(targetEvent);
    });

    it("includes events with partial hashtag match", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const event1 = makeEvent("1", "Earlier #work #project event", date1);
        const targetEvent = makeEvent(
            "target",
            "Current #work #meeting status",
            date2
        );

        const allEvents = [event1, targetEvent];

        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toHaveLength(2);
        expect(context).toContain(event1);
        expect(context).toContain(targetEvent);
    });

    it("excludes events with non-context-enhancing types", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const event1 = makeEvent(
            "1",
            "Earlier #work event",
            date1,
            "non-enhancing"
        );
        const targetEvent = makeEvent("target", "Current #work status", date2);

        const allEvents = [event1, targetEvent];

        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toHaveLength(1);
        expect(context).toContain(targetEvent);
    });

    it("includes events with context-enhancing type 'text'", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const event1 = makeEvent("1", "Earlier #work event", date1, "text");
        const targetEvent = makeEvent("target", "Current #work status", date2);

        const allEvents = [event1, targetEvent];

        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toHaveLength(2);
        expect(context).toContain(event1);
        expect(context).toContain(targetEvent);
    });

    it("includes events with context-enhancing type 'reg'", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const event1 = makeEvent("1", "Earlier #work event", date1, "reg");
        const targetEvent = makeEvent("target", "Current #work status", date2);

        const allEvents = [event1, targetEvent];

        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toHaveLength(2);
        expect(context).toContain(event1);
        expect(context).toContain(targetEvent);
    });

    it("handles multiple events with various conditions", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));
        const date3 = date2.advance(fromMinutes(10));
        const date4 = date3.advance(fromMinutes(10));
        const date5 = date4.advance(fromMinutes(10));

        const event1 = makeEvent("1", "Earlier #work event", date1, "text");
        const event2 = makeEvent("2", "Another #meeting event", date2, "text");
        const event3 = makeEvent("3", "Mixed #work #meeting", date3, "text");
        const targetEvent = makeEvent(
            "target",
            "Current #work status",
            date4,
            "text"
        );
        const event5 = makeEvent("5", "Later #work event", date5, "text");

        const allEvents = [event1, event2, event3, targetEvent, event5];

        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toHaveLength(4);
        expect(context).toContain(event1);
        expect(context).toContain(event3);
        expect(context).toContain(targetEvent);
        expect(context).toContain(event5);
        expect(context).not.toContain(event2); // No shared hashtags
    });

    it("includes events at exactly the same time", () => {
        const date = fromISOString("2024-01-01T12:00:00.000Z");

        const event1 = makeEvent("1", "Concurrent #work event", date);
        const targetEvent = makeEvent("target", "Current #work status", date);

        const allEvents = [event1, targetEvent];

        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toHaveLength(2);
        expect(context).toContain(event1);
        expect(context).toContain(targetEvent);
    });

    it("returns empty array when all events is empty", () => {
        const date = fromISOString("2024-01-01T12:00:00.000Z");
        const targetEvent = makeEvent("target", "Current #work status", date);
        const allEvents = [];

        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toEqual([]);
    });

    it("returns empty array when just an unmatched event is present", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const event1 = makeEvent("1", "Earlier #Work event", date1);
        const targetEvent = makeEvent("target", "Current #work status", date2);

        const allEvents = [event1];

        // Hashtags are case-sensitive, so #Work and #work are different
        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toHaveLength(0);
    });

    it("handles hashtags with different cases", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const event1 = makeEvent("1", "Earlier #Work event", date1);
        const targetEvent = makeEvent("target", "Current #work status", date2);

        const allEvents = [event1, targetEvent];

        // Hashtags are case-sensitive, so #Work and #work are different
        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toHaveLength(1);
        expect(context).toContain(targetEvent);
    });

    it("handles multiple hashtags in both events", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));

        const event1 = makeEvent("1", "Earlier #work #project #coding", date1);
        const targetEvent = makeEvent(
            "target",
            "Current #review #coding #testing",
            date2
        );

        const allEvents = [event1, targetEvent];

        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toHaveLength(2);
        expect(context).toContain(event1);
        expect(context).toContain(targetEvent);
    });

    it("returns events in the order they appear in all_events", () => {
        const date1 = fromISOString("2024-01-01T12:00:00.000Z");
        const date2 = date1.advance(fromMinutes(10));
        const date3 = date2.advance(fromMinutes(10));
        const date4 = date3.advance(fromMinutes(10));

        const event1 = makeEvent("1", "First #work event", date1);
        const event2 = makeEvent("2", "Second #work event", date2);
        const event3 = makeEvent("3", "Third #work event", date3);
        const targetEvent = makeEvent("target", "Current #work status", date4);

        const allEvents = [event1, event2, event3, targetEvent];

        const context = getEventBasicContext(allEvents, targetEvent);
        expect(context).toHaveLength(4);
        expect(context[0]).toBe(event1);
        expect(context[1]).toBe(event2);
        expect(context[2]).toBe(event3);
        expect(context[3]).toBe(targetEvent);
    });
});
