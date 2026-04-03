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

describe("GET /api/ontology", () => {
    it("returns an empty ontology by default", async () => {
        const { app } = await makeTestApp();
        const res = await request(app).get("/api/ontology");

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            ontology: { types: [], modifiers: [] },
        });
    });

    it("returns the stored ontology after a PUT", async () => {
        const { app } = await makeTestApp();

        const newOntology = {
            types: [{ name: "food", description: "Food consumed by the user." }],
            modifiers: [
                { name: "when", description: "Relative time, e.g. '1 hour ago'." },
            ],
        };

        await request(app)
            .put("/api/ontology")
            .send(newOntology)
            .set("Content-Type", "application/json");

        const res = await request(app).get("/api/ontology");

        expect(res.statusCode).toBe(200);
        expect(res.body.ontology).toEqual(newOntology);
    });

    it("returns ontology with modifiers that have only_for_type", async () => {
        const { app } = await makeTestApp();

        const newOntology = {
            types: [{ name: "food", description: "Food entries." }],
            modifiers: [
                { name: "duration", only_for_type: "food", description: "How long eating took." },
            ],
        };

        await request(app)
            .put("/api/ontology")
            .send(newOntology)
            .set("Content-Type", "application/json");

        const res = await request(app).get("/api/ontology");

        expect(res.statusCode).toBe(200);
        expect(res.body.ontology.modifiers[0].only_for_type).toBe("food");
    });
});
