const { processUserInput, isInputParseError } = require("../src/event/from_input");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");
const { stubEventLogRepository } = require("./stub_event_log_repository");

async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    await stubEventLogRepository(capabilities);
    return capabilities;
}

describe("Integration Tests", () => {
    test("complex workflow with multiple shortcuts and modifiers", async () => {
        const capabilities = await getTestCapabilities();

        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bw\\b", replacement: "WORK"},
                    {pattern: "\\bs\\b", replacement: "SOCIAL"},
                    {pattern: "\\bo\\b", replacement: "office"},
                    {pattern: "\\bh\\b", replacement: "home"},
                    {pattern: "\\bj\\b", replacement: "John"},
                    {pattern: "\\bm\\b", replacement: "Mary"},
                    {pattern: "\\bquick\\b", replacement: "w [loc o] [with j]"}
                ]
            });
        });

        const result = await processUserInput(capabilities, "quick - Daily standup meeting");

        expect(result.parsed).toEqual({
            type: "WORK",
            description: "- Daily standup meeting",
            modifiers: {
                loc: "office",
                with: "John"
            }
        });
    });

    test("edge case: shortcut creates invalid structure", async () => {
        const capabilities = await getTestCapabilities();

        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bbad\\b", replacement: "[invalid structure"}
                ]
            });
        });

        await expect(processUserInput(capabilities, "bad"))
            .rejects.toThrow();
        let errEdge;
        try {
            await processUserInput(capabilities, "bad");
        } catch (e) {
            errEdge = e;
        }
        expect(isInputParseError(errEdge)).toBe(true);
    });

    test("preserves complex descriptions", async () => {
        const capabilities = await getTestCapabilities();

        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: []
            });
        });

        const complexDescription = "Implemented new feature with \\[brackets\\] and special chars: @#$%";
        const result = await processUserInput(capabilities, `work - ${complexDescription}`);

        expect(result.parsed.description).toBe(`- ${complexDescription}`);
    });
});
