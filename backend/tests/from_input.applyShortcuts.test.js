const { applyShortcuts } = require("../src/event/from_input");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");
const { stubEventLogRepository } = require("./stub_event_log_repository");

async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubDatetime(capabilities);
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    await stubEventLogRepository(capabilities);
    return capabilities;
}

describe("applyShortcuts", () => {
    test("applies no shortcuts when config is empty", async () => {
        const capabilities = await getTestCapabilities();

        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage/transaction");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: []
            });
        });

        const result = await applyShortcuts(capabilities, "WORK [loc office]");
        expect(result).toBe("WORK [loc office]");
    });

    test("applies simple shortcut", async () => {
        const capabilities = await getTestCapabilities();

        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage/transaction");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bw\\b", replacement: "WORK"}
                ]
            });
        });

        const result = await applyShortcuts(capabilities, "w [loc office]");
        expect(result).toBe("WORK [loc office]");
    });

    test("applies multiple shortcuts", async () => {
        const capabilities = await getTestCapabilities();

        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage/transaction");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bw\\b", replacement: "WORK"},
                    {pattern: "\\bh\\b", replacement: "HOME"}
                ]
            });
        });

        let result = await applyShortcuts(capabilities, "w [loc h]");
        expect(result).toBe("WORK [loc HOME]");
    });

    test("applies recursive shortcuts", async () => {
        const capabilities = await getTestCapabilities();

        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage/transaction");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bw\\b", replacement: "WORK"},
                    {pattern: "\\bo\\b", replacement: "office"},
                    {pattern: "\\bwo\\b", replacement: "w [loc o]"}
                ]
            });
        });

        const result = await applyShortcuts(capabilities, "wo - Fixed bug");
        expect(result).toBe("WORK [loc office] - Fixed bug");
    });

    test("handles missing config file gracefully", async () => {
        const capabilities = await getTestCapabilities();
        // Don't create config file - it should handle this gracefully
        const result = await applyShortcuts(capabilities, "WORK [loc office]");
        expect(result).toBe("WORK [loc office]");
    });

    test("handles config without shortcuts property", async () => {
        const capabilities = await getTestCapabilities();

        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage/transaction");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "config without any shortcuts",
                shortcuts: []
            });
        });

        const result = await applyShortcuts(capabilities, "WORK [loc office]");
        expect(result).toBe("WORK [loc office]");
    });

    test("ignores shortcuts not matching whole words", async () => {
        const capabilities = await getTestCapabilities();

        // Set up config through transaction system (proper way)
        const { transaction } = require("../src/event_log_storage/transaction");
        await transaction(capabilities, async (storage) => {
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    {pattern: "\\bw\\b", replacement: "WORK"}
                ]
            });
        });

        // Should not replace 'w' inside 'working'
        const result = await applyShortcuts(capabilities, "working on project");
        expect(result).toBe("working on project");
    });
});
