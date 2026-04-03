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

describe("PUT /api/ontology", () => {
    it("saves a valid ontology and returns it", async () => {
        const { app } = await makeTestApp();

        const newOntology = {
            types: [{ name: "food", description: "Food consumed by the user." }],
            modifiers: [
                { name: "when", description: "Relative time, e.g. '1 hour ago'." },
                { name: "duration", only_for_type: "food", description: "How long eating took." },
            ],
        };

        const res = await request(app)
            .put("/api/ontology")
            .send(newOntology)
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(200);
        expect(res.body.ontology).toEqual(newOntology);
    });

    it("persists the ontology so GET returns it afterward", async () => {
        const { app } = await makeTestApp();

        const newOntology = {
            types: [{ name: "weight", description: "Body weight in kilograms." }],
            modifiers: [],
        };

        await request(app)
            .put("/api/ontology")
            .send(newOntology)
            .set("Content-Type", "application/json");

        const getRes = await request(app).get("/api/ontology");

        expect(getRes.statusCode).toBe(200);
        expect(getRes.body.ontology).toEqual(newOntology);
    });

    it("accepts an empty ontology", async () => {
        const { app } = await makeTestApp();

        const res = await request(app)
            .put("/api/ontology")
            .send({ types: [], modifiers: [] })
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(200);
        expect(res.body.ontology).toEqual({ types: [], modifiers: [] });
    });

    it("returns 400 for invalid ontology body (missing types)", async () => {
        const { app } = await makeTestApp();

        const res = await request(app)
            .put("/api/ontology")
            .send({ modifiers: [] })
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body).toHaveProperty("error");
    });

    it("returns 400 for invalid ontology body (missing modifiers)", async () => {
        const { app } = await makeTestApp();

        const res = await request(app)
            .put("/api/ontology")
            .send({ types: [] })
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body).toHaveProperty("error");
    });

    it("returns 400 for completely wrong shape", async () => {
        const { app } = await makeTestApp();

        const res = await request(app)
            .put("/api/ontology")
            .send({ notAnOntology: true })
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body).toHaveProperty("error");
    });

    it("returns 400 when a type entry is missing name", async () => {
        const { app } = await makeTestApp();

        const res = await request(app)
            .put("/api/ontology")
            .send({
                types: [{ description: "Missing name." }],
                modifiers: [],
            })
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body).toHaveProperty("error");
    });

    it("returns 400 when a modifier entry has non-string only_for_type", async () => {
        const { app } = await makeTestApp();

        const res = await request(app)
            .put("/api/ontology")
            .send({
                types: [],
                modifiers: [{ name: "duration", description: "dur", only_for_type: 42 }],
            })
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(400);
        expect(res.body).toHaveProperty("error");
    });
});
