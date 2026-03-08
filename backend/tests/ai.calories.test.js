jest.mock("openai", () => {
    const create = jest.fn();
    const OpenAI = jest.fn().mockImplementation(() => ({
        chat: {
            completions: {
                create,
            },
        },
    }));

    return {
        OpenAI,
        __mockCreate: create,
    };
});

const { make } = require("../src/ai/calories");
const { OpenAI, __mockCreate } = require("openai");

describe("ai calories", () => {
    /** @type {{ environment: { openaiAPIKey: jest.Mock<string, []> } }} */
    let capabilities;

    beforeEach(() => {
        capabilities = {
            environment: {
                openaiAPIKey: jest.fn().mockReturnValue("test-openai-key"),
            },
        };
        OpenAI.mockClear();
        __mockCreate.mockClear();
    });

    it("uses the stable chat completions model for calorie estimation", async () => {
        __mockCreate.mockResolvedValue({
            choices: [
                {
                    message: {
                        content: "420",
                    },
                },
            ],
        });

        const aiCalories = make(() => capabilities);
        const result = await aiCalories.estimateCalories("food: a bowl of pasta");

        expect(result).toBe(420);
        expect(OpenAI).toHaveBeenCalledWith({ apiKey: "test-openai-key" });
        expect(__mockCreate).toHaveBeenCalledWith(expect.objectContaining({
            model: "gpt-4o-mini",
        }));
    });

    it("returns 0 for empty entries without calling OpenAI", async () => {
        const aiCalories = make(() => capabilities);

        const result = await aiCalories.estimateCalories("   ");

        expect(result).toBe(0);
        expect(OpenAI).not.toHaveBeenCalled();
        expect(__mockCreate).not.toHaveBeenCalled();
    });
});
