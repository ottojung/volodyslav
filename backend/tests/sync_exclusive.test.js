/**
 * Integration tests for the ExclusiveProcess adoption in the sync module.
 * Validates that the scheduled job and the HTTP route share the same exclusive
 * process — i.e. a second concurrent invocation attaches to the already-running
 * computation rather than starting a new one.
 */

const request = require("supertest");
const expressApp = require("../src/express_app");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");
const { makeRouter } = require("../src/routes/sync");

// Mock the assets module to avoid real rsync calls.
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

    describe("synchronizeAll uses the ExclusiveProcess", () => {
        it("second call attaches to the first run rather than starting a new one", async () => {
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

            // Both promises should be the SAME object.
            expect(p1).toBe(p2);

            deferred.resolve();
            await Promise.all([p1, p2]);

            // The underlying sync ran only once.
            expect(syncDatabaseCallCount).toBe(1);
        });

        it("error propagates to all concurrent callers", async () => {
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

            // Next call should be a NEW initiator.
            const ep = synchronizeAllExclusiveProcess;
            const h = ep.invoke(() => Promise.resolve(undefined));
            expect(h.isInitiator).toBe(true);
            await h.result;
        });
    });

    describe("route controller attaches to a running job-level invocation", () => {
        it("returns running state when sync is already running (initiated by job)", async () => {
            const capabilities = getTestCapabilities();
            const deferred = makeDeferred();

            capabilities.interface.synchronizeDatabase = jest
                .fn()
                .mockReturnValue(deferred.promise);

            // Simulate the job starting the sync.
            const jobPromise = synchronizeAll(capabilities);
            expect(synchronizeAllExclusiveProcess.isRunning()).toBe(true);

            // Now the route is invoked.
            const app = expressApp.make();
            app.use("/api", makeRouter(capabilities));

            const startResponse = await request(app).post("/api/sync").send({});
            expect(startResponse.statusCode).toBe(202);
            expect(startResponse.body.status).toBe("running");

            // Finish the job's run.
            deferred.resolve();
            await jobPromise;
            await new Promise((r) => setImmediate(r));

            // Route should now reflect success.
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

            // Simulate the job starting the sync.
            const jobPromise = synchronizeAll(capabilities);

            const app = expressApp.make();
            app.use("/api", makeRouter(capabilities));

            // Route attaches while job is running.
            await request(app).post("/api/sync").send({});

            // Job crashes.
            deferred.reject(new Error("db-failure"));
            await jobPromise.catch(() => {});
            await new Promise((r) => setImmediate(r));

            // Route should reflect the error.
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

            // Only one underlying sync call.
            expect(syncCallCount).toBe(1);

            deferred.resolve();
            await jobPromise;
        });
    });
});
