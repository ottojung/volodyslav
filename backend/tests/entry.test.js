const { createEntry, getEntries } = require("../src/entry");
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
        expect(event.date).toEqual(new Date(fixedTime));
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

    it("throws if description is missing", async () => {
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "No description original",
            input: "No description input",
            type: "no-description-type",
            // no description field
        };
        await expect(createEntry(capabilities, entryData)).rejects.toThrow(
            /description field is required/
        );
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

    it("throws if modifiers contain non-string values", async () => {
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "Invalid modifiers original",
            input: "Invalid modifiers input",
            type: "invalid-modifiers-type",
            description: "Entry with invalid modifiers.",
            modifiers: { foo: 123 },
        };

        await expect(createEntry(capabilities, entryData)).rejects.toThrow(
            /modifiers must be key-value strings/
        );
    });
});

describe("getEntries pagination validation", () => {
    it("throws for non-positive page or limit", async () => {
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "orig",
            input: "inp",
            type: "t",
            description: "d",
        };
        await createEntry(capabilities, entryData);
        await expect(
            getEntries(capabilities, { page: 0, limit: 5 })
        ).rejects.toThrow();
        await expect(
            getEntries(capabilities, { page: 1, limit: 0 })
        ).rejects.toThrow();
    });
});

describe("getEntries ordering functionality", () => {
    it("sorts entries by date descending by default", async () => {
        const capabilities = await getTestCapabilities();
        
        // Create entries with different dates by controlling datetime.now()
        const baseTime = new Date("2023-01-01T10:00:00Z").getTime();
        
        capabilities.datetime.now.mockReturnValueOnce(baseTime);
        const entry1Data = {
            original: "First entry",
            input: "First entry",
            type: "test",
            description: "First entry description",
        };
        
        capabilities.datetime.now.mockReturnValueOnce(baseTime + 24 * 60 * 60 * 1000); // +1 day
        const entry2Data = {
            original: "Second entry",
            input: "Second entry", 
            type: "test",
            description: "Second entry description",
        };
        
        capabilities.datetime.now.mockReturnValueOnce(baseTime + 2 * 24 * 60 * 60 * 1000); // +2 days
        const entry3Data = {
            original: "Third entry",
            input: "Third entry",
            type: "test", 
            description: "Third entry description",
        };

        await createEntry(capabilities, entry1Data);
        await createEntry(capabilities, entry2Data);
        await createEntry(capabilities, entry3Data);

        const result = await getEntries(capabilities, { page: 1, limit: 10 });
        
        expect(result.results).toHaveLength(3);
        expect(result.order).toBe('dateDescending');
        // Most recent (third) should be first
        expect(result.results[0].description).toBe("Third entry description");
        expect(result.results[1].description).toBe("Second entry description");
        expect(result.results[2].description).toBe("First entry description");
    });

    it("sorts entries by date ascending when specified", async () => {
        const capabilities = await getTestCapabilities();
        
        // Create entries with different dates by controlling datetime.now()
        const baseTime = new Date("2023-01-01T10:00:00Z").getTime();
        
        capabilities.datetime.now.mockReturnValueOnce(baseTime);
        const entry1Data = {
            original: "First entry",
            input: "First entry",
            type: "test",
            description: "First entry description",
        };
        
        capabilities.datetime.now.mockReturnValueOnce(baseTime + 24 * 60 * 60 * 1000); // +1 day
        const entry2Data = {
            original: "Second entry",
            input: "Second entry",
            type: "test",
            description: "Second entry description", 
        };

        await createEntry(capabilities, entry1Data);
        await createEntry(capabilities, entry2Data);

        const result = await getEntries(capabilities, { 
            page: 1, 
            limit: 10, 
            order: 'dateAscending' 
        });
        
        expect(result.results).toHaveLength(2);
        expect(result.order).toBe('dateAscending');
        // Oldest (first) should be first
        expect(result.results[0].description).toBe("First entry description");
        expect(result.results[1].description).toBe("Second entry description");
    });

    it("sorts entries by date descending when explicitly specified", async () => {
        const capabilities = await getTestCapabilities();
        
        const baseTime = new Date("2023-01-01T10:00:00Z").getTime();
        
        capabilities.datetime.now.mockReturnValueOnce(baseTime);
        const entry1Data = {
            original: "First entry",
            input: "First entry",
            type: "test",
            description: "First entry description",
        };
        
        capabilities.datetime.now.mockReturnValueOnce(baseTime + 24 * 60 * 60 * 1000); // +1 day
        const entry2Data = {
            original: "Second entry", 
            input: "Second entry",
            type: "test",
            description: "Second entry description",
        };

        await createEntry(capabilities, entry1Data);
        await createEntry(capabilities, entry2Data);

        const result = await getEntries(capabilities, { 
            page: 1, 
            limit: 10, 
            order: 'dateDescending' 
        });
        
        expect(result.results).toHaveLength(2);
        expect(result.order).toBe('dateDescending');
        // Most recent (second) should be first
        expect(result.results[0].description).toBe("Second entry description");
        expect(result.results[1].description).toBe("First entry description");
    });

    it("throws error for invalid order parameter", async () => {
        const capabilities = await getTestCapabilities();
        
        const entryData = {
            original: "Test entry",
            input: "Test entry",
            type: "test",
            description: "Test entry description",
        };
        await createEntry(capabilities, entryData);

        await expect(
            getEntries(capabilities, { 
                page: 1, 
                limit: 10, 
                order: 'invalidOrder' 
            })
        ).rejects.toThrow('order must be either "dateAscending" or "dateDescending"');
    });

    it("applies pagination correctly with ordering", async () => {
        const capabilities = await getTestCapabilities();
        
        // Create 5 entries with different dates by controlling datetime.now()
        const baseTime = new Date("2023-01-01T10:00:00Z").getTime();
        for (let i = 1; i <= 5; i++) {
            capabilities.datetime.now.mockReturnValueOnce(baseTime + (i - 1) * 24 * 60 * 60 * 1000);
            await createEntry(capabilities, {
                original: `Entry ${i}`,
                input: `Entry ${i}`,
                type: "test",
                description: `Entry ${i} description`,
            });
        }

        // Get page 1 with limit 2, descending order (newest first)
        const result = await getEntries(capabilities, { 
            page: 1, 
            limit: 2, 
            order: 'dateDescending' 
        });
        
        expect(result.results).toHaveLength(2);
        expect(result.hasMore).toBe(true);
        expect(result.total).toBe(5);
        // Should get entries 5 and 4 (newest first)
        expect(result.results[0].description).toBe("Entry 5 description");
        expect(result.results[1].description).toBe("Entry 4 description");

        // Get page 2
        const result2 = await getEntries(capabilities, { 
            page: 2, 
            limit: 2, 
            order: 'dateDescending' 
        });
        
        expect(result2.results).toHaveLength(2);
        // Should get entries 3 and 2
        expect(result2.results[0].description).toBe("Entry 3 description");
        expect(result2.results[1].description).toBe("Entry 2 description");
    });
});
