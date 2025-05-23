const { createEntry } = require("../src/entry");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubEventLogRepository } = require("./stubs");

async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    await stubEventLogRepository(capabilities);
    return capabilities;
}

describe("createEntry (integration, with real capabilities)", () => {
    it("creates an event log entry with correct data (no file)", async () => {
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "Raw original text",
            input: "Processed input text",
            type: "test-type",
            description: "This is a test description.",
            modifiers: { custom: "value" },
            date: "2023-10-26T10:00:00.000Z",
        };

        const event = await createEntry(capabilities, entryData);
        expect(event.original).toBe(entryData.original);
        expect(event.input).toBe(entryData.input);
        expect(event.type).toBe(entryData.type);
        expect(event.description).toBe(entryData.description);
        expect(event.modifiers).toEqual(entryData.modifiers);
        expect(event.date).toEqual(new Date(entryData.date));
        expect(event.id).toBeDefined();
        expect(event.creator).toBeDefined();
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({
                eventId: event.id,
                type: event.type,
                hasFile: false,
            }),
            expect.stringContaining("Entry created")
        );
    });

    it("creates an event log entry with an asset when a file is provided", async () => {
        const fs = require("fs");
        const path = require("path");
        const os = require("os");
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-test-"));
        const tmpFilePath = path.join(tmpDir, "testfile.txt");
        fs.writeFileSync(tmpFilePath, "test content");
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "Original with file",
            input: "Input with file",
            type: "file-entry",
            description: "Description for file entry.",
        };
        const mockFile = { path: tmpFilePath };
        const event = await createEntry(capabilities, entryData, mockFile);
        expect(event.original).toBe(entryData.original);
        expect(event.input).toBe(entryData.input);
        expect(event.type).toBe(entryData.type);
        expect(event.description).toBe(entryData.description);
        expect(event.id).toBeDefined();
        expect(event.creator).toBeDefined();
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({
                eventId: event.id,
                type: event.type,
                hasFile: true,
            }),
            expect.stringContaining("Entry created")
        );
        fs.unlinkSync(tmpFilePath);
        fs.rmdirSync(tmpDir);
    });

    it("uses current date if date is not provided in entryData", async () => {
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "No date original",
            input: "No date input",
            type: "no-date-type",
            description: "Entry without a specific date.",
        };

        const before = Date.now();
        const event = await createEntry(capabilities, entryData);
        const after = Date.now();
        expect(event.date.getTime()).toBeGreaterThanOrEqual(before);
        expect(event.date.getTime()).toBeLessThanOrEqual(after);
    });

    it("creates an event log entry with empty modifiers if not provided", async () => {
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "No modifiers original",
            input: "No modifiers input",
            type: "no-modifiers-type",
            description: "Entry without modifiers.",
            // no modifiers field
        };
        const event = await createEntry(capabilities, entryData);
        expect(event.modifiers).toEqual({});
    });

    it("creates an event log entry with empty description if not provided", async () => {
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "No description original",
            input: "No description input",
            type: "no-description-type",
            // no description field
        };
        const event = await createEntry(capabilities, entryData);
        expect(event.description).toBeUndefined();
    });

    it("creates an event log entry with custom type and verifies type is set", async () => {
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "Custom type original",
            input: "Custom type input",
            type: "custom-type-xyz",
            description: "Entry with custom type.",
        };
        const event = await createEntry(capabilities, entryData);
        expect(event.type).toBe("custom-type-xyz");
    });

    it("creates an event log entry with a future date", async () => {
        const capabilities = await getTestCapabilities();
        const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString();
        const entryData = {
            original: "Future date original",
            input: "Future date input",
            type: "future-date-type",
            description: "Entry with a future date.",
            date: futureDate,
        };
        const event = await createEntry(capabilities, entryData);
        expect(event.date).toEqual(new Date(futureDate));
    });
});
