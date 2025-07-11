const { createEntry } = require("../src/entry");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubEventLogRepository, stubDatetime, stubLogger } = require("./stubs");

async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    stubLogger(capabilities);
    await stubEventLogRepository(capabilities);
    return capabilities;
}

describe("createEntry (integration, with real capabilities)", () => {
    it("creates an event log entry with correct data (no file)", async () => {
        const capabilities = await getTestCapabilities();
        const fixedTime = new Date("2023-10-26T10:00:00.000Z").getTime();
        capabilities.datetime.now.mockReturnValue(fixedTime);
        
        const entryData = {
            original: "Raw original text",
            input: "Processed input text",
            type: "test-type",
            description: "This is a test description.",
            modifiers: { custom: "value" },
        };

        const event = await createEntry(capabilities, entryData);
        expect(event.original).toBe(entryData.original);
        expect(event.input).toBe(entryData.input);
        expect(event.type).toBe(entryData.type);
        expect(event.description).toBe(entryData.description);
        expect(event.modifiers).toEqual(entryData.modifiers);
        expect(event.date.getTime()).toBe(fixedTime);
        expect(event.id).toBeDefined();
        expect(event.creator).toBeDefined();
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({
                eventId: event.id,
                type: event.type,
                fileCount: 0,
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
        const event = await createEntry(capabilities, entryData, [mockFile]);
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
                fileCount: 1,
            }),
            expect.stringContaining("Entry created")
        );
        fs.unlinkSync(tmpFilePath);
        fs.rmdirSync(tmpDir);
    });

    it("creates an event log entry with multiple assets when multiple files are provided", async () => {
        const fs = require("fs");
        const path = require("path");
        const os = require("os");
        const tmpDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "entry-multi-test-")
        );
        const tmpFilePath1 = path.join(tmpDir, "testfile1.txt");
        const tmpFilePath2 = path.join(tmpDir, "testfile2.txt");
        fs.writeFileSync(tmpFilePath1, "test content 1");
        fs.writeFileSync(tmpFilePath2, "test content 2");
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "Original with multiple files",
            input: "Input with multiple files",
            type: "multi-file-entry",
            description: "Description for multi-file entry.",
        };
        const mockFiles = [{ path: tmpFilePath1 }, { path: tmpFilePath2 }];
        const event = await createEntry(capabilities, entryData, mockFiles);
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
                fileCount: 2,
            }),
            expect.stringContaining("Entry created")
        );
        fs.unlinkSync(tmpFilePath1);
        fs.unlinkSync(tmpFilePath2);
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

    it("allows empty descriptions", async () => {
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "Empty description original",
            input: "Empty description input", 
            type: "empty-description-type",
            description: "", // Empty but present
        };
        const event = await createEntry(capabilities, entryData);
        expect(event.description).toBe("");
        expect(event.type).toBe("empty-description-type");
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
});

