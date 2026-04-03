const request = require("supertest");
const expressApp = require("../src/express_app");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

/** @type {{ status: import("../src/sync").SyncState["status"] }} */
let mockState = { status: "idle" };

jest.mock("../src/sync", () => {
    return {
        synchronizeAllExclusiveProcess: {
            invoke: jest.fn().mockImplementation(() => {}),
            getState: jest.fn().mockImplementation(() => mockState),
        },
        isSynchronizeAllError: jest.fn((error) => error?.name === "SynchronizeAllError"),
    };
});

const { synchronizeAllExclusiveProcess } = require("../src/sync");
const { makeRouter } = require("../src/routes/sync");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

async function makeApp() {
    const capabilities = getTestCapabilities();
    const app = expressApp.make();
    app.use("/api", makeRouter(capabilities));
    return app;
}

async function makeAppWithCapabilities() {
    const capabilities = getTestCapabilities();
    const app = expressApp.make();
    app.use("/api", makeRouter(capabilities));
    return { app, capabilities };
}

describe("sync route", () => {
    beforeEach(() => {
        mockState = { status: "idle" };
        synchronizeAllExclusiveProcess.invoke.mockClear();
        synchronizeAllExclusiveProcess.getState.mockClear();
    });

    it("POST /sync calls invoke and returns the current state", async () => {
        synchronizeAllExclusiveProcess.invoke.mockImplementation(() => {
            mockState = { status: "running", started_at: "2024-01-01T00:00:00.000Z", steps: [] };
        });
        const app = await makeApp();

        const response = await request(app).post("/api/sync").send({});

        expect(response.statusCode).toBe(202);
        expect(response.body.status).toBe("running");
        expect(synchronizeAllExclusiveProcess.invoke).toHaveBeenCalledWith(
            expect.objectContaining({ options: {} }),
        );
    });

    it("GET /sync returns the current state", async () => {
        mockState = {
            status: "success",
            started_at: "2024-01-01T00:00:00.000Z",
            finished_at: "2024-01-01T00:00:01.000Z",
            steps: [],
        };
        const app = await makeApp();

        const response = await request(app).get("/api/sync");

        expect(response.statusCode).toBe(200);
        expect(response.body.status).toBe("success");
    });

    it("GET /sync returns 202 when running", async () => {
        mockState = { status: "running", started_at: "2024-01-01T00:00:00.000Z", steps: [] };
        const app = await makeApp();

        const response = await request(app).get("/api/sync");

        expect(response.statusCode).toBe(202);
        expect(response.body.status).toBe("running");
    });

    it("GET /sync returns 500 when in error state", async () => {
        mockState = {
            status: "error",
            started_at: "2024-01-01T00:00:00.000Z",
            finished_at: "2024-01-01T00:00:01.000Z",
            error: { message: "Sync failed", details: [] },
            steps: [],
        };
        const app = await makeApp();

        const response = await request(app).get("/api/sync");

        expect(response.statusCode).toBe(500);
        expect(response.body.status).toBe("error");
    });

    it("idle state returns 200", async () => {
        mockState = { status: "idle" };
        const app = await makeApp();

        const response = await request(app).get("/api/sync");

        expect(response.statusCode).toBe(200);
        expect(response.body.status).toBe("idle");
    });

    it("POST /sync passes reset_to_hostname in options to invoke", async () => {
        synchronizeAllExclusiveProcess.invoke.mockImplementation(() => {
            mockState = { status: "running", started_at: "2024-01-01T00:00:00.000Z", steps: [] };
        });
        const app = await makeApp();

        const response = await request(app)
            .post("/api/sync")
            .send({ reset_to_hostname: "alice" });

        expect(response.statusCode).toBe(202);
        expect(synchronizeAllExclusiveProcess.invoke).toHaveBeenCalledWith(
            expect.objectContaining({ options: { resetToHostname: "alice" } }),
        );
    });

    it("rejects invalid reset_to_hostname values", async () => {
        const app = await makeApp();

        const response = await request(app)
            .post("/api/sync")
            .send({ reset_to_hostname: "bad host" });

        expect(response.statusCode).toBe(400);
        expect(response.body.error).toContain("Invalid reset_to_hostname value");
    });

    it("lists reset hostnames for the reset dropdown", async () => {
        const { app, capabilities } = await makeAppWithCapabilities();
        capabilities.git.call = jest.fn().mockResolvedValue({
            stdout: [
                "sha refs/heads/alice-main",
                "sha refs/heads/test-host-main",
                "sha refs/heads/not-a-host",
                "",
            ].join("\n"),
        });

        const response = await request(app).get("/api/sync/hostnames");

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual({
            hostnames: ["alice", "test-host"],
        });
        expect(capabilities.git.call).toHaveBeenCalledWith(
            "-c",
            "safe.directory=*",
            "ls-remote",
            "--heads",
            "--",
            expect.any(String)
        );
    });
});
