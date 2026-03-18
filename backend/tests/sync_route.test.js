const request = require("supertest");
const expressApp = require("../src/express_app");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

jest.mock("../src/sync", () => ({
    synchronizeAll: jest.fn(),
    isSynchronizeAllError: jest.fn((error) => error?.name === "SynchronizeAllError"),
}));

const { synchronizeAll } = require("../src/sync");
const { makeRouter } = require("../src/routes/sync");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

function makeDeferred() {
    /** @type {(value?: unknown) => void} */
    let resolve = () => {};
    /** @type {(reason?: unknown) => void} */
    let reject = () => {};

    const promise = new Promise((innerResolve, innerReject) => {
        resolve = innerResolve;
        reject = innerReject;
    });

    return { promise, resolve, reject };
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
        synchronizeAll.mockReset();
    });

    it("starts sync in the background and reports progress over GET /api/sync", async () => {
        const deferred = makeDeferred();
        synchronizeAll.mockReturnValue(deferred.promise);
        const app = await makeApp();

        const startResponse = await request(app).post("/api/sync").send({});

        expect(startResponse.statusCode).toBe(202);
        expect(startResponse.body.status).toBe("running");

        const runningResponse = await request(app).get("/api/sync");
        expect(runningResponse.statusCode).toBe(202);
        expect(runningResponse.body.status).toBe("running");

        deferred.resolve();
        await new Promise((resolve) => setImmediate(resolve));

        const finishedResponse = await request(app).get("/api/sync");
        expect(finishedResponse.statusCode).toBe(200);
        expect(finishedResponse.body.status).toBe("success");
    });

    it("returns detailed error information after a failed background sync", async () => {
        synchronizeAll.mockRejectedValue({
            name: "SynchronizeAllError",
            errors: [
                {
                    name: "GeneratorsSyncError",
                    message: "Generators database sync failed: git push failed",
                    cause: new Error("git push failed"),
                },
            ],
        });
        const app = await makeApp();

        const startResponse = await request(app)
            .post("/api/sync")
            .send({ reset_to_hostname: "test-host" });
        expect(startResponse.statusCode).toBe(202);

        await new Promise((resolve) => setImmediate(resolve));

        const failedResponse = await request(app).get("/api/sync");
        expect(failedResponse.statusCode).toBe(500);
        expect(failedResponse.body).toMatchObject({
            status: "error",
            reset_to_hostname: "test-host",
            error: {
                message: "Sync failed: Generators database sync failed: git push failed",
                details: [
                    {
                        name: "GeneratorsSyncError",
                        message: "Generators database sync failed: git push failed",
                        causes: ["git push failed"],
                    },
                ],
            },
        });
    });

    it("includes an empty steps array in the initial running state", async () => {
        const deferred = makeDeferred();
        synchronizeAll.mockReturnValue(deferred.promise);
        const app = await makeApp();

        const startResponse = await request(app).post("/api/sync").send({});

        expect(startResponse.statusCode).toBe(202);
        expect(startResponse.body.steps).toEqual([]);

        deferred.resolve();
    });

    it("reports completed steps via the onStepComplete callback during sync", async () => {
        const deferred = makeDeferred();

        synchronizeAll.mockImplementation((_capabilities, _options, onStepComplete) => {
            onStepComplete?.({ name: "generators", status: "success" });
            return deferred.promise;
        });

        const app = await makeApp();
        await request(app).post("/api/sync").send({});

        const runningResponse = await request(app).get("/api/sync");
        expect(runningResponse.statusCode).toBe(202);
        expect(runningResponse.body.steps).toEqual([
            { name: "generators", status: "success" },
        ]);

        deferred.resolve();
    });

    it("includes completed steps in the final success state", async () => {
        synchronizeAll.mockImplementation((_capabilities, _options, onStepComplete) => {
            onStepComplete?.({ name: "generators", status: "success" });
            onStepComplete?.({ name: "assets", status: "success" });
            return Promise.resolve();
        });

        const app = await makeApp();
        await request(app).post("/api/sync").send({});
        await new Promise((resolve) => setImmediate(resolve));

        const finishedResponse = await request(app).get("/api/sync");
        expect(finishedResponse.statusCode).toBe(200);
        expect(finishedResponse.body.steps).toEqual([
            { name: "generators", status: "success" },
            { name: "assets", status: "success" },
        ]);
    });

    it("includes completed steps in the final error state", async () => {
        synchronizeAll.mockImplementation((_capabilities, _options, onStepComplete) => {
            onStepComplete?.({ name: "generators", status: "error" });
            return Promise.reject({
                name: "SynchronizeAllError",
                errors: [
                    {
                        name: "GeneratorsSyncError",
                        message: "Generators database sync failed",
                        cause: new Error("db error"),
                    },
                ],
            });
        });

        const app = await makeApp();
        await request(app).post("/api/sync").send({});
        await new Promise((resolve) => setImmediate(resolve));

        const failedResponse = await request(app).get("/api/sync");
        expect(failedResponse.statusCode).toBe(500);
        expect(failedResponse.body.steps).toEqual([
            { name: "generators", status: "error" },
        ]);
    });

    it("starts sync with reset_to_hostname when a custom hostname is provided", async () => {
        synchronizeAll.mockResolvedValue(undefined);
        const app = await makeApp();

        const response = await request(app)
            .post("/api/sync")
            .send({ reset_to_hostname: "alice" });

        expect(response.statusCode).toBe(202);
        expect(synchronizeAll).toHaveBeenCalledWith(
            expect.anything(),
            { resetToHostname: "alice" },
            expect.any(Function)
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
