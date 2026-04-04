/**
 * Integration tests for the ExclusiveProcess adoption in the sync module.
 */

const request = require("supertest");
const expressApp = require("../src/express_app");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");
const { makeRouter } = require("../src/routes/sync");
const { isExclusiveProcess } = require("../src/exclusive_process");

jest.mock("../src/assets", () => ({
    synchronize: jest.fn().mockResolvedValue(undefined),
    isAssetsSynchronizationError: jest.fn(() => false),
}));

const { synchronize: assetsSynchronize } = require("../src/assets");

const {
    synchronizeAll,
    synchronizeAllExclusiveProcess,
} = require("../src/sync");

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeDeferred() {
    /** @type {(value?: unknown) => void} */
    let resolve = () => {};
    /** @type {(reason?: unknown) => void} */
    let reject = () => {};
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    capabilities.interface = {
        synchronizeDatabase: jest.fn().mockResolvedValue(undefined),
    };
    return capabilities;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("sync — ExclusiveProcess adoption", () => {
    beforeEach(() => {
        assetsSynchronize.mockResolvedValue(undefined);
    });

    it("synchronizeAllExclusiveProcess is a plain ExclusiveProcess instance", () => {
        expect(isExclusiveProcess(synchronizeAllExclusiveProcess)).toBe(true);
    });

    describe("compatible-options: attach to the running run", () => {
        it("second call with no options attaches to the first run", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            let syncDatabaseCallCount = 0;
            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockImplementation(() => {
                    syncDatabaseCallCount++;
                    return deferred.promise;
                });

            const p1 = synchronizeAll(capabilities);
            const p2 = synchronizeAll(capabilities);

            expect(p1).toBe(p2);

            deferred.resolve();
            await Promise.all([p1, p2]);

            expect(syncDatabaseCallCount).toBe(1);
        });

        it("error propagates to all concurrent callers on the same run", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockReturnValue(deferred.promise);

            const p1 = synchronizeAll(capabilities);
            const p2 = synchronizeAll(capabilities);

            deferred.reject(new Error("db-crash"));

            await Promise.all([
                expect(p1).rejects.toMatchObject({ name: "SynchronizeAllError" }),
                expect(p2).rejects.toMatchObject({ name: "SynchronizeAllError" }),
            ]);
        });

        it("process resets after a crash so the next call starts fresh", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockReturnValue(deferred.promise);

            const p1 = synchronizeAll(capabilities);
            deferred.reject(new Error("crash"));
            await p1.catch(() => {});

            expect(synchronizeAllExclusiveProcess.isRunning()).toBe(false);

            // Next call should succeed with a fresh mock
            capabilities.interface.synchronizeDatabase = jest.fn().mockResolvedValue(undefined);
            await synchronizeAll(capabilities);
            expect(synchronizeAllExclusiveProcess.isRunning()).toBe(false);
        });

        it("state transitions from running to success", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockReturnValue(deferred.promise);

            synchronizeAll(capabilities);
            expect(synchronizeAllExclusiveProcess.getState().status).toBe("running");

            deferred.resolve();
            await new Promise((r) => setImmediate(r));

            expect(synchronizeAllExclusiveProcess.getState().status).toBe("success");
        });

        it("state includes completed steps after a successful sync", async () => {
            const capabilities = getTestCapabilities();

            await synchronizeAll(capabilities);

            const state = synchronizeAllExclusiveProcess.getState();
            expect(state.status).toBe("success");
            expect(state).toHaveProperty('steps', expect.arrayContaining([
                { name: "generators", status: "success" },
                { name: "assets", status: "success" },
            ]));
        });

        it("state transitions to error on failure", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockReturnValue(deferred.promise);

            const p1 = synchronizeAll(capabilities);
            deferred.reject(new Error("db-crash"));
            await p1.catch(() => {});
            await new Promise((r) => setImmediate(r));

            const state = synchronizeAllExclusiveProcess.getState();
            expect(state.status).toBe("error");
            expect(state).toHaveProperty("steps", expect.arrayContaining([
                { name: "generators", status: "error" },
            ]));
        });

        it("subscribers receive running state immediately after invoke", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockReturnValue(deferred.promise);

            const receivedStates = [];
            synchronizeAllExclusiveProcess.invoke({ capabilities }, (s) => receivedStates.push(s));

            // First subscriber notification happens synchronously (running state)
            // then further notifications happen asynchronously
            deferred.resolve();
            await new Promise((r) => setImmediate(r));

            const runningState = receivedStates.find((s) => s.status === "running");
            expect(runningState).toBeDefined();
        });
    });

    describe("P1 — conflicting options are queued, not silently ignored", () => {
        it("call with reset_to_hostname is queued when a plain sync is already running", async () => {
            const capabilities = getTestCapabilities();
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();

            let callIndex = 0;
            const capturedOptions = [];

            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockImplementation((opts) => {
                    capturedOptions.push(opts);
                    return [deferred1, deferred2][callIndex++].promise;
                });

            const p1 = synchronizeAll(capabilities);
            expect(synchronizeAllExclusiveProcess.isRunning()).toBe(true);
            expect(callIndex).toBe(1);

            const p2 = synchronizeAll(capabilities, { resetToHostname: "alice" });
            expect(callIndex).toBe(1); // still only one DB call

            deferred1.resolve();
            await p1;
            await new Promise((r) => setImmediate(r));

            expect(callIndex).toBe(2);
            expect(capturedOptions[1]).toEqual({ resetToHostname: "alice" });

            deferred2.resolve();
            await p2;
        });

        it("caller with conflicting options gets a promise that resolves after the queued run", async () => {
            const capabilities = getTestCapabilities();
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();

            let callIndex = 0;
            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockImplementation(() => [deferred1, deferred2][callIndex++].promise);

            const p1 = synchronizeAll(capabilities);
            const p2 = synchronizeAll(capabilities, { resetToHostname: "alice" });

            expect(p1).not.toBe(p2);

            deferred1.resolve();
            await p1;

            let p2Resolved = false;
            p2.then(() => { p2Resolved = true; });

            await new Promise((r) => setImmediate(r));
            expect(p2Resolved).toBe(false);

            deferred2.resolve();
            await p2;
            expect(p2Resolved).toBe(true);
        });

        it("last-write-wins when multiple conflicting calls queue up during a single run", async () => {
            const capabilities = getTestCapabilities();
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();

            let callIndex = 0;
            const capturedOptions = [];
            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockImplementation((opts) => {
                    capturedOptions.push(opts);
                    return [deferred1, deferred2][callIndex++].promise;
                });

            const p1 = synchronizeAll(capabilities);
            const p2a = synchronizeAll(capabilities, { resetToHostname: "alice" });
            const p2b = synchronizeAll(capabilities, { resetToHostname: "bob" });

            expect(p2a).toBe(p2b);

            deferred1.resolve();
            await p1;
            await new Promise((r) => setImmediate(r));

            expect(capturedOptions[1]).toEqual({ resetToHostname: "bob" });

            deferred2.resolve();
            await Promise.all([p2a, p2b]);
        });

        it("same-reset attach is not confused with a conflicting queue", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            let callCount = 0;
            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockImplementation(() => {
                    callCount++;
                    return deferred.promise;
                });

            const p1 = synchronizeAll(capabilities, { resetToHostname: "alice" });
            const p2 = synchronizeAll(capabilities, { resetToHostname: "alice" });
            expect(p1).toBe(p2);
            expect(callCount).toBe(1);

            deferred.resolve();
            await Promise.all([p1, p2]);
        });
    });

    describe("route controller attaches to a running job-level invocation", () => {
        it("returns running state when sync is already running (initiated by job)", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockReturnValue(deferred.promise);

            const jobPromise = synchronizeAll(capabilities);
            expect(synchronizeAllExclusiveProcess.isRunning()).toBe(true);

            const app = expressApp.make();
            app.use("/api", makeRouter(capabilities));

            const startResponse = await request(app).post("/api/sync").send({});
            expect(startResponse.statusCode).toBe(202);
            expect(startResponse.body.status).toBe("running");

            deferred.resolve();
            await jobPromise;
            await new Promise((r) => setImmediate(r));

            const finishedResponse = await request(app).get("/api/sync");
            expect(finishedResponse.statusCode).toBe(200);
            expect(finishedResponse.body.status).toBe("success");
        });

        it("route controller transitions to error when the job-level run crashes", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockReturnValue(deferred.promise);

            const jobPromise = synchronizeAll(capabilities);

            const app = expressApp.make();
            app.use("/api", makeRouter(capabilities));

            await request(app).post("/api/sync").send({});

            deferred.reject(new Error("db-failure"));
            await jobPromise.catch(() => {});
            await new Promise((r) => setImmediate(r));

            const failedResponse = await request(app).get("/api/sync");
            expect(failedResponse.statusCode).toBe(500);
            expect(failedResponse.body.status).toBe("error");
        });

        it("does not start a second sync run when the route calls start() twice while attached", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            let syncCallCount = 0;
            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockImplementation(() => {
                    syncCallCount++;
                    return deferred.promise;
                });

            const jobPromise = synchronizeAll(capabilities);

            const app = expressApp.make();
            app.use("/api", makeRouter(capabilities));

            const r1 = await request(app).post("/api/sync").send({});
            const r2 = await request(app).post("/api/sync").send({});

            expect(r1.statusCode).toBe(202);
            expect(r2.statusCode).toBe(202);

            expect(syncCallCount).toBe(1);

            deferred.resolve();
            await jobPromise;
        });

        it("route request with reset_to_hostname is queued when a job run is active", async () => {
            const capabilities = getTestCapabilities();
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();

            let callIndex = 0;
            const capturedOptions = [];
            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockImplementation((opts) => {
                    capturedOptions.push(opts);
                    return [deferred1, deferred2][callIndex++].promise;
                });

            const jobPromise = synchronizeAll(capabilities);

            const app = expressApp.make();
            app.use("/api", makeRouter(capabilities));

            const routeStartResp = await request(app)
                .post("/api/sync")
                .send({ reset_to_hostname: "alice" });
            expect(routeStartResp.statusCode).toBe(202);
            expect(routeStartResp.body.status).toBe("running");

            expect(callIndex).toBe(1);

            deferred1.resolve();
            await jobPromise;
            await new Promise((r) => setImmediate(r));

            expect(callIndex).toBe(2);
            expect(capturedOptions[1]).toEqual({ resetToHostname: "alice" });

            deferred2.resolve();
            await new Promise((r) => setImmediate(r));

            const finishedResp = await request(app).get("/api/sync");
            expect(finishedResp.statusCode).toBe(200);
            expect(finishedResp.body.status).toBe("success");
        });
    });
});
