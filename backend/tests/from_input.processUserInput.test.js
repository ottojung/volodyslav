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

describe("processUserInput", () => {
    test("processes complete pipeline without shortcuts", async () => {
        const capabilities = await getTestCapabilities();

        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: []
            });
        });
        const result = await processUserInput(capabilities, "WORK [loc office] - Fixed bug");

        expect(result).toEqual({
            original: "WORK [loc office] - Fixed bug",
            input: "WORK [loc office] - Fixed bug",
            parsed: {
                type: "WORK",
                description: "- Fixed bug",
                modifiers: {
                    loc: "office"
                }
            }
        });
    });

    test("processes complete pipeline with shortcuts", async () => {
        const capabilities = await getTestCapabilities();

        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bw\\b", replacement: "WORK"},
                    {pattern: "\\bo\\b", replacement: "office"}
                ]
            });
        });

        const result = await processUserInput(capabilities, "  w [loc o] - Fixed bug  ");

        expect(result).toEqual({
            original: "  w [loc o] - Fixed bug  ",
            input: "WORK [loc office] - Fixed bug",
            parsed: {
                type: "WORK",
                description: "- Fixed bug",
                modifiers: {
                    loc: "office"
                }
            }
        });
    });

    test("handles whitespace normalization", async () => {
        const capabilities = await getTestCapabilities();

        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: []
            });
        });

        const result = await processUserInput(capabilities, "  \t\n  WORK  \t\n  ");

        expect(result.original).toBe("  \t\n  WORK  \t\n  ");
        expect(result.input).toBe("WORK");
        expect(result.parsed.type).toBe("WORK");
    });

    test("propagates parsing errors", async () => {
        const capabilities = await getTestCapabilities();

        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: []
            });
        });

        await expect(processUserInput(capabilities, "[invalid] format"))
            .rejects.toThrow();
        let errProc;
        try {
            await processUserInput(capabilities, "[invalid] format");
        } catch (e) {
            errProc = e;
        }
        expect(isInputParseError(errProc)).toBe(true);
    });

    test("handles minimal input", async () => {
        const capabilities = await getTestCapabilities();

        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: []
            });
        });

        const result = await processUserInput(capabilities, "WORK");

        expect(result.parsed).toEqual({
            type: "WORK",
            description: "",
            modifiers: {}
        });
    });
});
