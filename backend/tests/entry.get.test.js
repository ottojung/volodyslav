const { createEntry, getEntries } = require("../src/entry");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubEventLogRepository, stubDatetime, stubLogger } = require("./stubs");
const { fromISOString } = require("../src/datetime");
const { fromDays } = require("../src/datetime/duration");
const { getDescription } = require("../src/event/computed");

async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    stubLogger(capabilities);
    await stubEventLogRepository(capabilities);
    return capabilities;
}

describe("getEntries pagination validation", () => {
    it("throws for non-positive page or limit", async () => {
        const capabilities = await getTestCapabilities();
        const entryData = {
            original: "orig",
            input: "t d",
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
        const baseTime = fromISOString("2023-01-01T10:00:00Z");

        capabilities.datetime.now.mockReturnValueOnce(
            baseTime
        );
        const entry1Data = {
            original: "test First entry description",
            input: "test First entry description",
        };
        await createEntry(capabilities, entry1Data);

        capabilities.datetime.now.mockReturnValueOnce(
            baseTime.advance(fromDays(1))
        ); // +1 day
        const entry2Data = {
            original: "test Second entry description",
            input: "test Second entry description",
        };

        await createEntry(capabilities, entry2Data);

        capabilities.datetime.now.mockReturnValueOnce(
            baseTime.advance(fromDays(2))
        ); // +2 days
        const entry3Data = {
            original: "test Third entry description",
            input: "test Third entry description",
        };

        await createEntry(capabilities, entry3Data);

        const result = await getEntries(capabilities, { page: 1, limit: 10 });

        expect(result.results).toHaveLength(3);
        expect(result.order).toBe('dateDescending');
        // Most recent (third) should be first
        expect(getDescription(result.results[0])).toBe("Third entry description");
        expect(getDescription(result.results[1])).toBe("Second entry description");
        expect(getDescription(result.results[2])).toBe("First entry description");
    });

    it("sorts entries by date ascending when specified", async () => {
        const capabilities = await getTestCapabilities();

        // Create entries with different dates by controlling datetime.now()
        const baseTime = fromISOString("2023-01-01T10:00:00Z");

        capabilities.datetime.now.mockReturnValueOnce(
            baseTime
        );
        const entry1Data = {
            original: "test First entry description",
            input: "test First entry description",
        };

        capabilities.datetime.now.mockReturnValueOnce(
            baseTime.advance(fromDays(1))
        ); // +1 day
        const entry2Data = {
            original: "test Second entry description",
            input: "test Second entry description",
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
        expect(getDescription(result.results[0])).toBe("First entry description");
        expect(getDescription(result.results[1])).toBe("Second entry description");
    });

    it("sorts entries by date descending when explicitly specified", async () => {
        const capabilities = await getTestCapabilities();

        const baseTime = fromISOString("2023-01-01T10:00:00Z");

        capabilities.datetime.now.mockReturnValueOnce(
            baseTime
        );
        const entry1Data = {
            original: "test First entry description",
            input: "test First entry description",
        };

        await createEntry(capabilities, entry1Data);

        capabilities.datetime.now.mockReturnValueOnce(
            baseTime.advance(fromDays(1))
        ); // +1 day
        const entry2Data = {
            original: "test Second entry description",
            input: "test Second entry description",
        };
        await createEntry(capabilities, entry2Data);

        const result = await getEntries(capabilities, {
            page: 1,
            limit: 10,
            order: 'dateDescending'
        });

        expect(result.results).toHaveLength(2);
        expect(result.order).toBe('dateDescending');
        // Most recent (second) should be first
        expect(getDescription(result.results[0])).toBe("Second entry description");
        expect(getDescription(result.results[1])).toBe("First entry description");
    });

    it("throws error for invalid order parameter", async () => {
        const capabilities = await getTestCapabilities();

        const entryData = {
            original: "test Test entry description",
            input: "test Test entry description",
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
        const baseTime = fromISOString("2023-01-01T10:00:00Z");
        for (let i = 1; i <= 5; i++) {
            capabilities.datetime.now.mockReturnValueOnce(
                baseTime.advance(fromDays(i - 1))
            );
            await createEntry(capabilities, {
                original: `test Entry ${i} description`,
                input: `test Entry ${i} description`,
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
        // Should get entries 5 and 4 (newest first)
        expect(getDescription(result.results[0])).toBe("Entry 5 description");
        expect(getDescription(result.results[1])).toBe("Entry 4 description");

        // Get page 2
        const result2 = await getEntries(capabilities, {
            page: 2,
            limit: 2,
            order: 'dateDescending'
        });

        expect(result2.results).toHaveLength(2);
        // Should get entries 3 and 2
        expect(getDescription(result2.results[0])).toBe("Entry 3 description");
        expect(getDescription(result2.results[1])).toBe("Entry 2 description");
    });
});
