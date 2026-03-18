const fs = require("fs").promises;
const path = require("path");
const request = require("supertest");

const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const { processDiaryAudios } = require("../src/diary");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    stubEventLogRepository,
} = require("./stubs");

/**
 * @returns {Promise<{ app: import("express").Express, capabilities: object }>}
 */
async function makeTestApp() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    capabilities.datetime.timeZone = () => "America/Los_Angeles";
    capabilities.checker.isFileStable = jest.fn().mockResolvedValue(true);
    await stubEventLogRepository(capabilities);
    const app = expressApp.make();
    capabilities.logger.enableHttpCallsLogging(app);
    await addRoutes(capabilities, app);
    return { app, capabilities };
}

describe("diary audio asset association across timezones", () => {
    test("recordings named in UTC are converted to local time and remain associated with their entry", async () => {
        const { app, capabilities } = await makeTestApp();
        const assetsDir = capabilities.environment.eventLogAssetsDirectory();
        const diaryDir = capabilities.environment.diaryAudiosDirectory();
        await fs.mkdir(diaryDir, { recursive: true });
        await fs.writeFile(
            path.join(diaryDir, "20260318T020619Z.ogg"),
            "fake audio"
        );

        await processDiaryAudios(capabilities);

        const entries = await capabilities.interface.getAllEvents();
        expect(entries).toHaveLength(1);

        const entry = entries[0];
        expect(entry.date.year).toBe(2026);
        expect(entry.date.month).toBe(3);
        expect(entry.date.day).toBe(17);
        expect(entry.date.hour).toBe(19);
        expect(entry.date.minute).toBe(6);
        expect(entry.date.second).toBe(19);
        expect(entry.date.zone).toBe("UTC-7");

        const serializedEntryResponse = await request(app)
            .get(`/api/entries/${entry.id.identifier}`);
        expect(serializedEntryResponse.statusCode).toBe(200);
        expect(serializedEntryResponse.body.entry.date).toBe("2026-03-17T19:06:19-0700");

        const expectedAssetFilePath = path.join(
            assetsDir,
            "2026-03",
            "17",
            entry.id.identifier,
            "20260318T020619Z.ogg"
        );
        await expect(fs.access(expectedAssetFilePath)).resolves.toBeUndefined();

        const assetsResponse = await request(app)
            .get(`/api/entries/${entry.id.identifier}/assets`);
        expect(assetsResponse.statusCode).toBe(200);
        expect(assetsResponse.body.assets).toEqual([
            expect.objectContaining({
                filename: "20260318T020619Z.ogg",
                mediaType: "audio",
                url: `/assets/2026-03/17/${entry.id.identifier}/20260318T020619Z.ogg`,
            }),
        ]);
    });
});
