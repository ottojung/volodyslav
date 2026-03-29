jest.mock("openai", () => ({
    OpenAI: jest.fn(),
}));

const { OpenAI } = require("openai");
const { make } = require("../src/ai/diary_questions");

/**
 * @returns {{ environment: { openaiAPIKey: jest.Mock } }}
 */
function makeCapabilities() {
    return {
        environment: {
            openaiAPIKey: jest.fn().mockReturnValue("test-openai-key"),
        },
    };
}

describe("ai/diary_questions", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("returns [] and skips OpenAI call when maxQuestions clamps to 0", async () => {
        const create = jest.fn();
        OpenAI.mockImplementation(() => ({
            chat: { completions: { create } },
        }));

        const ai = make(() => makeCapabilities());
        const result = await ai.generateQuestions("short transcript", [], 0);

        expect(result).toEqual([]);
        expect(create).not.toHaveBeenCalled();
    });

    it("truncates model output to clamped maxQuestions", async () => {
        const create = jest.fn().mockResolvedValue({
            choices: [
                {
                    message: {
                        content: JSON.stringify({
                            questions: [
                                { text: "Q1", intent: "clarifying" },
                                { text: "Q2", intent: "warm_reflective" },
                                { text: "Q3", intent: "forward" },
                            ],
                        }),
                    },
                },
            ],
        });
        OpenAI.mockImplementation(() => ({
            chat: { completions: { create } },
        }));

        const ai = make(() => makeCapabilities());
        const result = await ai.generateQuestions("long transcript", [], 2);

        expect(result).toEqual([
            { text: "Q1", intent: "clarifying" },
            { text: "Q2", intent: "warm_reflective" },
        ]);
        expect(result).toHaveLength(2);
    });
});
