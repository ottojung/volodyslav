const { createEntry } = require("../src/entry");
const { fromISOString } = require("../src/datetime");
const eventId = require("../src/event/id");
const { getType, getDescription, getModifiers } = require("../src/event/computed");
const { makeFromExistingFile } = require("../src/filesystem/file_ref");

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
        const fixedDateTime = fromISOString("2023-10-26T10:00:00.000Z");
        capabilities.datetime.now.mockReturnValue(
            fixedDateTime
        );
        
        const entryData = {
            original: "Raw original text",
            input: "testtype [custom value] This is a test description.",
        };

        const event = await createEntry(capabilities, entryData);
        expect(event.original).toBe(entryData.original);
        expect(event.input).toBe(entryData.input);
        expect(getType(event)).toBe("testtype");
        expect(getDescription(event)).toBe("This is a test description.");
        expect(getModifiers(event)).toEqual({ custom: "value" });
        expect(event.date).toEqual(fixedDateTime);
        expect(event.id).toBeDefined();
        expect(event.creator).toBeDefined();
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({
                eventId: eventId.toString(event.id),
                type: getType(event),
                fileCount: 0,
            }),
            expect.stringContaining("Entry created")
        );
    });

    it("creates an event log entry with an asset when a file is provided", async () => {
        const path = require("path");
        const capabilities = await getTestCapabilities();
        const tmpDir = await capabilities.creator.createTemporaryDirectory();
        const tmpFilePath = path.join(tmpDir, "testfile.txt");
        const sourceFile = await capabilities.creator.createFile(tmpFilePath);
        await capabilities.writer.writeFile(sourceFile, "test content");
        const entryData = {
            original: "Original with file",
            input: "fileentry Description for file entry.",
        };
        const mockFile = makeFromExistingFile(
            sourceFile,
            (p) => capabilities.reader.readFileAsBuffer(p)
        );
        const event = await createEntry(capabilities, entryData, [mockFile]);
        expect(event.original).toBe(entryData.original);
        expect(event.input).toBe(entryData.input);
        expect(getType(event)).toBe("fileentry");
        expect(getDescription(event)).toBe("Description for file entry.");
        expect(event.id).toBeDefined();
        expect(event.creator).toBeDefined();
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({
                eventId: eventId.toString(event.id),
                type: getType(event),
                fileCount: 1,
            }),
            expect.stringContaining("Entry created")
        );
        await capabilities.deleter.deleteDirectory(tmpDir);
    });

    it("creates an event log entry with multiple assets when multiple files are provided", async () => {
        const path = require("path");
        const capabilities = await getTestCapabilities();
        const tmpDir = await capabilities.creator.createTemporaryDirectory();
        const tmpFilePath1 = path.join(tmpDir, "testfile1.txt");
        const tmpFilePath2 = path.join(tmpDir, "testfile2.txt");
        const sourceFile1 = await capabilities.creator.createFile(tmpFilePath1);
        const sourceFile2 = await capabilities.creator.createFile(tmpFilePath2);
        await capabilities.writer.writeFile(sourceFile1, "test content 1");
        await capabilities.writer.writeFile(sourceFile2, "test content 2");
        const entryData = {
            original: "Original with multiple files",
            input: "multifileentry Description for multi-file entry.",
        };
        const mockFiles = [
            makeFromExistingFile(sourceFile1, (p) => capabilities.reader.readFileAsBuffer(p)),
            makeFromExistingFile(sourceFile2, (p) => capabilities.reader.readFileAsBuffer(p)),
        ];
        const event = await createEntry(capabilities, entryData, mockFiles);
        expect(event.original).toBe(entryData.original);
        expect(event.input).toBe(entryData.input);
        expect(getType(event)).toBe("multifileentry");
        expect(getDescription(event)).toBe("Description for multi-file entry.");
        expect(event.id).toBeDefined();
        expect(event.creator).toBeDefined();
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({
                eventId: eventId.toString(event.id),
                type: getType(event),
                fileCount: 2,
            }),
            expect.stringContaining("Entry created")
        );
        await capabilities.deleter.deleteDirectory(tmpDir);
    });

    it("uses current date if date is not provided in entryData", async () => {
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "No date original",
            input: "nodatetype Entry without a specific date.",
        };

        // Use datetime capability instead of Date.now() for consistent time
        const beforeDateTime = capabilities.datetime.now();
        
        const event = await createEntry(capabilities, entryData);
        
        const afterDateTime = capabilities.datetime.now();
        
        expect(event.date.isAfterOrEqual(beforeDateTime)).toBe(true);
        expect(event.date.isBeforeOrEqual(afterDateTime)).toBe(true);
    });

    it("creates an event log entry with empty modifiers if not provided in input", async () => {
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "No modifiers original",
            input: "nomodifierstype Entry without modifiers.",
        };
        const event = await createEntry(capabilities, entryData);
        expect(getModifiers(event)).toEqual({});
    });

    it("allows empty descriptions", async () => {
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "Empty description original",
            input: "emptydescriptiontype",
        };
        const event = await createEntry(capabilities, entryData);
        expect(getDescription(event)).toBe("");
        expect(getType(event)).toBe("emptydescriptiontype");
    });

    it("creates an event log entry with custom type and verifies type is set", async () => {
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "Custom type original",
            input: "customtypexyz Entry with custom type.",
        };
        const event = await createEntry(capabilities, entryData);
        expect(getType(event)).toBe("customtypexyz");
    });
});

