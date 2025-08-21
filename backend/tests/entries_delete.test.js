const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    stubEventLogRepository,
} = require("./stubs");

async function makeTestApp() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    await stubEventLogRepository(capabilities);
    const app = expressApp.make();
    capabilities.logger.enableHttpCallsLogging(app);
    await addRoutes(capabilities, app);
    return { app, capabilities };
}

describe("DELETE /api/entries", () => {
    it("deletes an existing entry", async () => {
        const { app } = await makeTestApp();

        const createRes = await request(app)
            .post("/api/entries")
            .send({ rawInput: "testtype - desc" })
            .set("Content-Type", "application/json");
        expect(createRes.statusCode).toBe(201);
        const id = createRes.body.entry.id;

        const delRes = await request(app).delete(`/api/entries?id=${id}`);
        expect(delRes.statusCode).toBe(200);
        expect(delRes.body.success).toBe(true);

        const listRes = await request(app).get("/api/entries");
        expect(listRes.body.results).toHaveLength(0);
    });

    it("returns 400 when id is missing", async () => {
        const { app } = await makeTestApp();
        const res = await request(app).delete("/api/entries");
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/id/);
    });

    it("returns 500 when entry does not exist", async () => {
        const { app, capabilities } = await makeTestApp();
        const res = await request(app).delete(
            "/api/entries?id=nonexistent"
        );
        expect(res.statusCode).toBe(500);
        expect(capabilities.logger.logError).toHaveBeenCalled();
    });

    it("returns 400 for empty id string", async () => {
        const { app } = await makeTestApp();
        const res = await request(app).delete("/api/entries?id=");
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/id/);
    });

    it("returns 400 when id is provided multiple times", async () => {
        const { app } = await makeTestApp();
        const res = await request(app).delete(
            "/api/entries?id=one&id=two"
        );
        expect(res.statusCode).toBe(400);
        expect(res.body.error).toMatch(/id/);
    });

    it("logs a message when deletion succeeds", async () => {
        const { app, capabilities } = await makeTestApp();
        const createRes = await request(app)
            .post("/api/entries")
            .send({ rawInput: "testtype - desc" })
            .set("Content-Type", "application/json");
        expect(createRes.statusCode).toBe(201);
        const id = createRes.body.entry.id;

        const delRes = await request(app).delete(`/api/entries?id=${id}`);
        expect(delRes.statusCode).toBe(200);
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({ entry_id: expect.anything() }),
            expect.stringContaining("Entry deleted")
        );
    });

});
