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
                    name: "EventLogSyncError",
                    message: "Event log sync failed: git push failed",
                    cause: new Error("git push failed"),
                },
            ],
        });
        const app = await makeApp();

        const startResponse = await request(app)
            .post("/api/sync")
            .send({ reset_to_theirs: true });
        expect(startResponse.statusCode).toBe(202);

        await new Promise((resolve) => setImmediate(resolve));

        const failedResponse = await request(app).get("/api/sync");
        expect(failedResponse.statusCode).toBe(500);
        expect(failedResponse.body).toMatchObject({
            status: "error",
            reset_to_theirs: true,
            error: {
                message: "Sync failed: Event log sync failed: git push failed",
                details: [
                    {
                        name: "EventLogSyncError",
                        message: "Event log sync failed: git push failed",
                        causes: ["git push failed"],
                    },
                ],
            },
        });
    });
});
