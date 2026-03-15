const { createDefaultGraphDefinition } = require("../src/generators/interface/default_graph");
const individual = require("../src/generators/individual");

/**
 * @param {Array<import("../src/generators/incremental_graph/types").NodeDef>} graph
 * @param {string} output
 */
function findNode(graph, output) {
    const node = graph.find((candidate) => candidate.output === output);
    if (!node) {
        throw new Error(`Expected node ${output} in default graph`);
    }
    return node;
}

describe("default graph computor wiring", () => {
    test("uses extracted computors for direct node mappings", () => {
        const graph = createDefaultGraphDefinition({});

        expect(findNode(graph, "sorted_events_descending").computor).toBe(individual.sortedEventsDescending.computor);
        expect(findNode(graph, "sorted_events_ascending").computor).toBe(individual.sortedEventsAscending.computor);
        expect(findNode(graph, "last_entries(n)").computor).toBe(individual.lastEntries.computor);
        expect(findNode(graph, "first_entries(n)").computor).toBe(individual.firstEntries.computor);
        expect(findNode(graph, "events_count").computor).toBe(individual.eventsCount.computor);
        expect(findNode(graph, "meta_events").computor).toBe(individual.metaEvents.computor);
        expect(findNode(graph, "event_context").computor).toBe(individual.eventContext.computor);
        expect(findNode(graph, "event(e)").computor).toBe(individual.event.computor);
        expect(findNode(graph, "event_transcription(e, a)").computor).toBe(individual.eventTranscription.computor);
    });

    test("uses extracted factory computors for capabilities-bound nodes", async () => {
        const capabilities = {};
        const graph = createDefaultGraphDefinition(capabilities);

        await expect(findNode(graph, "calories(e)").computor([], undefined, []))
            .rejects
            .toThrow("Expected input of type event for calories(e) computor");
        await expect(individual.calories.makeComputor(capabilities)([], undefined, []))
            .rejects
            .toThrow("Expected input of type event for calories(e) computor");

        await expect(findNode(graph, "transcription(a)").computor([], undefined, [123]))
            .rejects
            .toThrow("Expected first binding to be a string for transcription(a) computor, got 123");
        await expect(individual.transcription.makeComputor(capabilities)([], undefined, [123]))
            .rejects
            .toThrow("Expected first binding to be a string for transcription(a) computor, got 123");
    });
});
