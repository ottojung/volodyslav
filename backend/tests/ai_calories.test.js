/**
 * Unit tests for the ai/calories module.
 */

jest.mock("openai", () => ({
    OpenAI: jest.fn(),
}));

const { OpenAI } = require("openai");
const {
    CALORIES_MODEL,
    SYSTEM_PROMPT,
    isAICaloriesError,
    make,
    makeCaloriesEntryText,
    makeCaloriesMessages,
    makeCaloriesMessagesWithOntology,
} = require("../src/ai/calories");

function makeMockCapabilities() {
    return {
        environment: {
            openaiAPIKey: jest.fn().mockReturnValue("test-api-key"),
        },
    };
}

function setupMockClient(responseText) {
    const mockCreate = jest.fn().mockResolvedValue({
        choices: [
            {
                message: {
                    content: responseText,
                },
            },
        ],
    });

    OpenAI.mockImplementation(() => ({
        chat: {
            completions: {
                create: mockCreate,
            },
        },
    }));

    return {
        mockCreate,
    };
}

function makeSerializedEvent(id, input) {
    return {
        id,
        input,
        type: "text",
        description: input,
        original: input,
        modifiers: {},
    };
}

describe("ai/calories", () => {
    beforeEach(() => {
        OpenAI.mockReset();
    });

    test("makeCaloriesEntryText builds the selected target-and-context prompt shape", () => {
        const targetEvent = makeSerializedEvent("1", "food: sandwich");
        const contextEvents = [targetEvent];

        const entry = makeCaloriesEntryText(targetEvent, contextEvents);
        const messages = makeCaloriesMessages(targetEvent, contextEvents);

        expect(messages).toEqual([
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: entry },
        ]);
        expect(entry).toBe(
            "Target event:\nfood: sandwich\n\nBasic context (related events for disambiguation only):\n- none"
        );
        expect(SYSTEM_PROMPT).toContain("Target event");
        expect(SYSTEM_PROMPT).toContain("Basic context");
        expect(SYSTEM_PROMPT).toContain("Do not add calories from context events");
    });

    test("make sends the improved prompt to OpenAI and parses integer responses", async () => {
        const { mockCreate } = setupMockClient("420");
        const capabilities = makeMockCapabilities();
        const aiCalories = make(() => capabilities);
        const targetEvent = makeSerializedEvent("2", "food: sandwich");
        const contextEvents = [
            makeSerializedEvent("1", "text packed lunch"),
            targetEvent,
        ];
        const emptyOntology = { types: [], modifiers: [] };

        const result = await aiCalories.estimateCalories(targetEvent, contextEvents, emptyOntology);

        expect(result).toBe(420);
        expect(OpenAI).toHaveBeenCalledWith({ apiKey: "test-api-key" });
        expect(mockCreate).toHaveBeenCalledWith({
            model: CALORIES_MODEL,
            messages: makeCaloriesMessagesWithOntology(targetEvent, contextEvents, emptyOntology),
        });
    });

    test("returns N/A for blank target input without calling OpenAI", async () => {
        const capabilities = makeMockCapabilities();
        const aiCalories = make(() => capabilities);
        const targetEvent = makeSerializedEvent("1", "   ");
        const emptyOntology = { types: [], modifiers: [] };

        const result = await aiCalories.estimateCalories(targetEvent, [targetEvent], emptyOntology);

        expect(result).toBe("N/A");
        expect(OpenAI).not.toHaveBeenCalled();
    });

    test("wraps non-numeric model responses as AICaloriesError", async () => {
        setupMockClient("about 500 calories");
        const capabilities = makeMockCapabilities();
        const aiCalories = make(() => capabilities);
        const targetEvent = makeSerializedEvent("1", "food: sandwich");
        const emptyOntology = { types: [], modifiers: [] };
        const error = await aiCalories
            .estimateCalories(targetEvent, [targetEvent], emptyOntology)
            .catch((caught) => caught);

        expect(isAICaloriesError(error)).toBe(true);
        expect(error.message).toContain("non-numeric response");
    });
});
