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
    makeCaloriesMessages,
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

describe("ai/calories", () => {
    beforeEach(() => {
        OpenAI.mockReset();
    });

    test("makeCaloriesMessages builds the selected target-and-context prompt shape", () => {
        const entry = "Target event:\nfood: sandwich\n\nBasic context (related events for disambiguation only):\n- none";
        const messages = makeCaloriesMessages(entry);

        expect(messages).toEqual([
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: entry },
        ]);
        expect(SYSTEM_PROMPT).toContain("Target event");
        expect(SYSTEM_PROMPT).toContain("Basic context");
        expect(SYSTEM_PROMPT).toContain("Do not add calories from context events");
    });

    test("make sends the improved prompt to OpenAI and parses integer responses", async () => {
        const { mockCreate } = setupMockClient("420");
        const capabilities = makeMockCapabilities();
        const aiCalories = make(() => capabilities);
        const entry = "Target event:\nfood: sandwich\n\nBasic context (related events for disambiguation only):\n1. text packed lunch";

        const result = await aiCalories.estimateCalories(entry);

        expect(result).toBe(420);
        expect(OpenAI).toHaveBeenCalledWith({ apiKey: "test-api-key" });
        expect(mockCreate).toHaveBeenCalledWith({
            model: CALORIES_MODEL,
            messages: makeCaloriesMessages(entry),
        });
    });

    test("returns N/A for blank input without calling OpenAI", async () => {
        const capabilities = makeMockCapabilities();
        const aiCalories = make(() => capabilities);

        const result = await aiCalories.estimateCalories("   ");

        expect(result).toBe("N/A");
        expect(OpenAI).not.toHaveBeenCalled();
    });

    test("wraps non-numeric model responses as AICaloriesError", async () => {
        setupMockClient("about 500 calories");
        const capabilities = makeMockCapabilities();
        const aiCalories = make(() => capabilities);
        const error = await aiCalories
            .estimateCalories("Target event:\nfood: sandwich\n\nBasic context (related events for disambiguation only):\n- none")
            .catch((caught) => caught);

        expect(isAICaloriesError(error)).toBe(true);
        expect(error.message).toContain("non-numeric response");
    });
});
