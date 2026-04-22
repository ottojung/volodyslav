const {
    makeExclusiveProcess,
    isExclusiveProcess,
    isExclusiveProcessHandle,
} = require("../src/exclusive_process");

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

const noopCapabilities = { logger: { logError: () => {} } };

// Helper: make a procedure that ignores mutateState and runs a simple async fn.
// procedure: (mutateState, arg) => Promise<T>
function simpleProcedure(fn) {
    return (_mutateState, arg) => fn(arg);
}

describe("ExclusiveProcess", () => {
    describe("makeExclusiveProcess", () => {
        it("returns an ExclusiveProcess instance", () => {
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => Promise.resolve()),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });
            expect(isExclusiveProcess(ep)).toBe(true);
        });

        it("creates independent instances that do not share state", () => {
            const deferred = makeDeferred();
            const ep1 = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => deferred.promise),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });
            const ep2 = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => deferred.promise),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            const h1 = ep1.invoke(undefined);
            expect(h1.isInitiator).toBe(true);

            // ep2 is idle — also an initiator
            const h2 = ep2.invoke(undefined);
            expect(h2.isInitiator).toBe(true);

            deferred.resolve();
        });

        it("procedure receives the argument", async () => {
            let received;
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: (_mutateState, arg) => {
                    received = arg;
                    return Promise.resolve();
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });
            await ep.invoke("hello").result;
            expect(received).toBe("hello");
        });

        it("procedure receives a mutateState function that updates state", async () => {
            const ep = makeExclusiveProcess({
                initialState: "initial",
                procedure: (mutateState, _arg) => {
                    mutateState(() => "updated-1");
                    mutateState(() => "updated-2");
                    return Promise.resolve();
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });
            await ep.invoke(undefined).result;
            expect(ep.getState()).toBe("updated-2");
        });
    });

    describe("getState", () => {
        it("returns the initialState before any run", () => {
            const ep = makeExclusiveProcess({
                initialState: { status: "idle" },
                procedure: simpleProcedure(() => Promise.resolve()),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });
            expect(ep.getState()).toEqual({ status: "idle" });
        });

        it("reflects sync state update before invoke returns", () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess({
                initialState: { status: "idle" },
                procedure: (mutateState, _arg) => {
                    mutateState(() => ({ status: "running" }));
                    return deferred.promise;
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            ep.invoke(undefined);
            // State updated synchronously by the first mutateState call in procedure.
            expect(ep.getState()).toEqual({ status: "running" });

            deferred.resolve();
        });

        it("reflects async state updates after the transformer promise resolves", async () => {
            const ep = makeExclusiveProcess({
                initialState: 0,
                procedure: async (mutateState, _arg) => {
                    await mutateState(() => Promise.resolve(1));
                    await mutateState(() => Promise.resolve(2));
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            await ep.invoke(undefined).result;
            expect(ep.getState()).toBe(2);
        });

        it("serializes non-awaited async mutateState calls in invocation order", async () => {
            const deferredFirst = makeDeferred();
            const deferredSecond = makeDeferred();
            const ep = makeExclusiveProcess({
                initialState: 0,
                procedure: (mutateState, _arg) => {
                    const first = mutateState(() => deferredFirst.promise.then(() => 1));
                    const second = mutateState(() => deferredSecond.promise.then(() => 2));
                    deferredSecond.resolve();
                    deferredFirst.resolve();
                    return Promise.all([first, second]).then(() => undefined);
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            await ep.invoke(undefined).result;
            expect(ep.getState()).toBe(2);
        });

        it("state persists after run completes", async () => {
            const ep = makeExclusiveProcess({
                initialState: { status: "idle" },
                procedure: (mutateState, _arg) => {
                    mutateState(() => ({ status: "running" }));
                    return Promise.resolve().then(() => {
                        mutateState(() => ({ status: "done" }));
                    });
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });
            await ep.invoke(undefined).result;
            expect(ep.getState()).toEqual({ status: "done" });
        });
    });

    describe("mutateState", () => {
        it("sync transformer updates state synchronously", () => {
            const deferred = makeDeferred();
            let capturedStateMidRun;
            const ep = makeExclusiveProcess({
                initialState: "before",
                procedure: (mutateState, _arg) => {
                    mutateState(() => "after");
                    capturedStateMidRun = ep.getState();
                    return deferred.promise;
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            ep.invoke(undefined);
            expect(capturedStateMidRun).toBe("after");
            deferred.resolve();
        });

        it("subscribers receive the new state after each sync mutation", async () => {
            const states = [];
            const ep = makeExclusiveProcess({
                initialState: 0,
                procedure: (mutateState, _arg) => {
                    mutateState(() => 1);
                    mutateState(() => 2);
                    return Promise.resolve();
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            ep.invoke(undefined, (s) => states.push(s));
            await new Promise((r) => setImmediate(r));

            expect(states).toEqual([1, 2]);
        });

        it("subscribers registered by attachers receive subsequent state updates", async () => {
            let doMutate;
            const ep = makeExclusiveProcess({
                initialState: 0,
                procedure: (mutateState, _arg) => {
                    return new Promise((resolve) => {
                        doMutate = () => {
                            mutateState(() => 42);
                            resolve();
                        };
                    });
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            const initiatorStates = [];
            const attacherStates = [];

            ep.invoke(undefined, (s) => initiatorStates.push(s));
            ep.invoke(undefined, (s) => attacherStates.push(s));

            doMutate();
            await new Promise((r) => setImmediate(r));

            expect(initiatorStates).toEqual([42]);
            expect(attacherStates).toEqual([42]);
        });

        it("a throwing subscriber does not abort notifications for subsequent subscribers", async () => {
            const received = [];
            let doMutate;
            const ep = makeExclusiveProcess({
                initialState: 0,
                procedure: (mutateState, _arg) => {
                    return new Promise((resolve) => {
                        doMutate = () => {
                            mutateState(() => 99);
                            resolve();
                        };
                    });
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            ep.invoke(undefined, (_s) => { throw new Error("subscriber error"); });
            ep.invoke(undefined, (s) => received.push(s));

            doMutate();
            await new Promise((r) => setImmediate(r));

            expect(received).toEqual([99]);
        });

        it("logs a thrown subscriber error via getCapabilities", async () => {
            const loggedErrors = [];
            const fakeLogger = { logError: (obj, _msg) => loggedErrors.push(obj) };
            const fakeCapabilities = { logger: fakeLogger };
            let doMutate;
            const ep = makeExclusiveProcess({
                initialState: 0,
                procedure: (mutateState, _arg) => {
                    return new Promise((resolve) => {
                        doMutate = () => {
                            mutateState(() => 1);
                            resolve();
                        };
                    });
                },
                conflictor: () => "attach",
                getCapabilities: () => fakeCapabilities,
            });

            ep.invoke(undefined, (_s) => { throw new Error("boom"); });

            doMutate();
            await new Promise((r) => setImmediate(r));

            expect(loggedErrors.length).toBe(1);
            expect(loggedErrors[0].error).toBeInstanceOf(Error);
            expect(loggedErrors[0].error.message).toBe("boom");
        });

        it("logs an async subscriber rejection via getCapabilities", async () => {
            const loggedErrors = [];
            const fakeLogger = { logError: (obj, _msg) => loggedErrors.push(obj) };
            const fakeCapabilities = { logger: fakeLogger };
            let doMutate;
            const ep = makeExclusiveProcess({
                initialState: 0,
                procedure: (mutateState, _arg) => {
                    return new Promise((resolve) => {
                        doMutate = () => {
                            mutateState(() => 1);
                            resolve();
                        };
                    });
                },
                conflictor: () => "attach",
                getCapabilities: () => fakeCapabilities,
            });

            ep.invoke(undefined, (_s) => Promise.reject(new Error("async boom")));

            doMutate();
            await new Promise((r) => setImmediate(r));

            expect(loggedErrors.length).toBe(1);
            expect(loggedErrors[0].error).toBeInstanceOf(Error);
            expect(loggedErrors[0].error.message).toBe("async boom");
        });

        it("subscribers are cleared between runs", async () => {
            const firstRunStates = [];
            const secondRunStates = [];
            let runCount = 0;
            const deferreds = [makeDeferred(), makeDeferred()];

            const ep = makeExclusiveProcess({
                initialState: 0,
                procedure: (mutateState, _arg) => {
                    const d = deferreds[runCount++];
                    d.promise.then(() => mutateState(() => runCount * 10));
                    return d.promise.then(() => undefined);
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            const h1 = ep.invoke(undefined, (s) => firstRunStates.push(s));
            deferreds[0].resolve();
            await h1.result;

            const h2 = ep.invoke(undefined, (s) => secondRunStates.push(s));
            deferreds[1].resolve();
            await h2.result;

            expect(firstRunStates).toEqual([10]);
            expect(secondRunStates).toEqual([20]);
        });

        it("ignores late mutateState calls after run completion", async () => {
            let lateMutate = () => Promise.resolve();
            const ep = makeExclusiveProcess({
                initialState: 0,
                procedure: (mutateState, _arg) => {
                    mutateState(() => 1);
                    lateMutate = () => mutateState(() => 999);
                    return Promise.resolve();
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            await ep.invoke(undefined).result;
            expect(ep.getState()).toBe(1);

            await lateMutate();
            expect(ep.getState()).toBe(1);

            await ep.invoke(undefined).result;
            expect(ep.getState()).toBe(1);
        });

        it("initiator handle exposes the same mutateState passed to the procedure", () => {
            const deferred = makeDeferred();
            let procedureMutateState;
            const ep = makeExclusiveProcess({
                initialState: 0,
                procedure: (mutateState, _arg) => {
                    procedureMutateState = mutateState;
                    return deferred.promise;
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            const handle = ep.invoke(undefined);
            expect(handle.isInitiator).toBe(true);
            expect(handle).toHaveProperty('mutateState', procedureMutateState);
            deferred.resolve();
        });
    });

    describe("invoke — idle process", () => {
        it("starts the procedure and returns an initiator handle", async () => {
            let called = false;
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(async () => {
                    called = true;
                    return 42;
                }),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            const handle = ep.invoke(undefined);

            expect(isExclusiveProcessHandle(handle)).toBe(true);
            expect(handle.isInitiator).toBe(true);
            await expect(handle.result).resolves.toBe(42);
            expect(called).toBe(true);
        });

        it("resets to idle after a successful run", async () => {
            let run = 0;
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => Promise.resolve(++run)),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            await ep.invoke(undefined).result;

            const h = ep.invoke(undefined);
            expect(h.isInitiator).toBe(true);
            await expect(h.result).resolves.toBe(2);
        });

        it("resets to idle after a failed run", async () => {
            let fail = true;
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() =>
                    fail ? Promise.reject(new Error("boom")) : Promise.resolve("recovered")
                ),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            await ep.invoke(undefined).result.catch(() => {});

            fail = false;
            const h = ep.invoke(undefined);
            expect(h.isInitiator).toBe(true);
            await expect(h.result).resolves.toBe("recovered");
        });

        it("handles a rejected async procedure and resets the same ep to idle", async () => {
            let fail = true;
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: async (_mutateState, _arg) => {
                    if (fail) throw new Error("async error");
                    return "ok";
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            const handle = ep.invoke(undefined);
            expect(handle.isInitiator).toBe(true);
            await expect(handle.result).rejects.toThrow("async error");

            // The SAME process should be idle again — second invoke is an initiator
            fail = false;
            const h2 = ep.invoke(undefined);
            expect(h2.isInitiator).toBe(true);
            await expect(h2.result).resolves.toBe("ok");
        });
    });

    describe("invoke — running process (attaching)", () => {
        it("returns an attacher handle when a run is already in progress", async () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => deferred.promise),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            const h1 = ep.invoke(undefined);
            const h2 = ep.invoke(undefined);

            expect(h1.isInitiator).toBe(true);
            expect(h2.isInitiator).toBe(false);

            deferred.resolve("result");
            await Promise.all([h1.result, h2.result]);
        });

        it("attacher handle has currentState set to state at invocation time", async () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess({
                initialState: { status: "idle" },
                procedure: (mutateState, _arg) => {
                    mutateState(() => ({ status: "running" }));
                    return deferred.promise;
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            ep.invoke(undefined);
            // State is now "running" (set synchronously)
            const h2 = ep.invoke(undefined);

            expect(h2.isInitiator).toBe(false);
            expect(h2).toHaveProperty('currentState', { status: "running" });

            deferred.resolve();
            await h2.result;
        });

        it("attacher shares the same result promise as the initiator", async () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => deferred.promise),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            const h1 = ep.invoke(undefined);
            const h2 = ep.invoke(undefined);

            deferred.resolve("shared-value");

            const [r1, r2] = await Promise.all([h1.result, h2.result]);
            expect(r1).toBe("shared-value");
            expect(r2).toBe("shared-value");
        });

        it("procedure only runs once even with multiple concurrent invocations", async () => {
            const deferred = makeDeferred();
            let procedureCallCount = 0;
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: (_mutateState, _arg) => {
                    procedureCallCount++;
                    return deferred.promise;
                },
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            ep.invoke(undefined);
            ep.invoke(undefined);
            ep.invoke(undefined);

            deferred.resolve();
            await deferred.promise;
            await new Promise((r) => setTimeout(r, 0));

            expect(procedureCallCount).toBe(1);
        });

        it("multiple attachers all receive the same result", async () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => deferred.promise),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            const handles = [
                ep.invoke(undefined),
                ep.invoke(undefined),
                ep.invoke(undefined),
                ep.invoke(undefined),
            ];

            expect(handles[0].isInitiator).toBe(true);
            for (let i = 1; i < handles.length; i++) {
                expect(handles[i].isInitiator).toBe(false);
            }

            deferred.resolve("all-get-this");

            const results = await Promise.all(handles.map((h) => h.result));
            for (const r of results) {
                expect(r).toBe("all-get-this");
            }
        });
    });

    describe("conflictor", () => {
        it("queues a conflicting call instead of attaching", async () => {
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();
            let callIndex = 0;
            const deferreds = [deferred1, deferred2];
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure((_type) => deferreds[callIndex++].promise),
                conflictor: (current, incoming) => current !== incoming ? "queue" : "attach",
                getCapabilities: () => noopCapabilities,
            });

            const h1 = ep.invoke("A");
            const h2 = ep.invoke("B"); // conflicts → queue

            expect(h1.isInitiator).toBe(true);
            expect(h2.isInitiator).toBe(false);
            expect(h1.result).not.toBe(h2.result);

            deferred1.resolve("result-A");
            await h1.result;
            await new Promise((r) => setImmediate(r));

            // B should now be running
            expect(callIndex).toBe(2);
            deferred2.resolve("result-B");
            await expect(h2.result).resolves.toBe("result-B");
        });

        it("queued attacher handle has currentState set to state at queue time", async () => {
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();
            let callIndex = 0;
            const ep = makeExclusiveProcess({
                initialState: { count: 0 },
                procedure: (mutateState, _type) => {
                    mutateState((s) => ({ count: s.count + 1 }));
                    return [deferred1, deferred2][callIndex++].promise;
                },
                conflictor: (current, incoming) => current !== incoming ? "queue" : "attach",
                getCapabilities: () => noopCapabilities,
            });

            ep.invoke("A");
            // State is now { count: 1 } (sync update)
            const h2 = ep.invoke("B"); // queued

            expect(h2.isInitiator).toBe(false);
            expect(h2).toHaveProperty('currentState', { count: 1 });

            deferred1.resolve();
            await new Promise((r) => setImmediate(r));
            deferred2.resolve();
            await h2.result;
        });

        it("last-write-wins for arg when multiple conflicting calls queue up", async () => {
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();
            let callIndex = 0;
            const capturedArgs = [];
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: (_mutateState, type) => {
                    capturedArgs.push(type);
                    return [deferred1, deferred2][callIndex++].promise;
                },
                conflictor: (cur, nw) => cur !== nw ? "queue" : "attach",
                getCapabilities: () => noopCapabilities,
            });

            ep.invoke("A");
            const h2a = ep.invoke("B");
            const h2b = ep.invoke("C"); // overwrites B

            // Both h2a and h2b share the same pending promise
            expect(h2a.result).toBe(h2b.result);

            deferred1.resolve();
            await new Promise((r) => setImmediate(r));

            // The queued run used last-write "C"
            expect(capturedArgs[1]).toBe("C");
            deferred2.resolve("done");
            await Promise.all([h2a.result, h2b.result]);
        });

        it("all queued callers' subscribers receive state notifications from the queued run", async () => {
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();
            let callIndex = 0;
            const ep = makeExclusiveProcess({
                initialState: "initial",
                procedure: (mutateState, arg) => {
                    const d = [deferred1, deferred2][callIndex++];
                    d.promise.then(() => mutateState(() => `state-from-${arg}`));
                    return d.promise.then(() => `done-${arg}`);
                },
                conflictor: (cur, nw) => cur !== nw ? "queue" : "attach",
                getCapabilities: () => noopCapabilities,
            });

            const statesB = [];
            const statesC = [];
            ep.invoke("A");
            const h2a = ep.invoke("B", (s) => statesB.push(s)); // first queued
            const h2b = ep.invoke("C", (s) => statesC.push(s)); // overwrites arg, composes subscriber

            // Both h2a and h2b share the same pending promise
            expect(h2a.result).toBe(h2b.result);

            deferred1.resolve();
            await new Promise((r) => setImmediate(r));

            deferred2.resolve();
            await Promise.all([h2a.result, h2b.result]);
            await new Promise((r) => setImmediate(r));

            // Both queued callers received state from the queued run (arg C)
            expect(statesB).toEqual(["state-from-C"]);
            expect(statesC).toEqual(["state-from-C"]);
        });

        it("compatible call attaches even when conflictor is defined", async () => {
            const deferred = makeDeferred();
            let calls = 0;
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: (_mutateState, _arg) => { calls++; return deferred.promise; },
                conflictor: (cur, nw) => cur !== nw ? "queue" : "attach",
                getCapabilities: () => noopCapabilities,
            });

            const h1 = ep.invoke("same");
            const h2 = ep.invoke("same"); // same → attach

            expect(h1.result).toBe(h2.result);
            expect(calls).toBe(1);
            deferred.resolve("ok");
            await Promise.all([h1.result, h2.result]);
        });

        it("queued run starts after initiator crashes", async () => {
            const deferred1 = makeDeferred();
            const deferred2 = makeDeferred();
            let callIndex = 0;
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure((_v) => [deferred1, deferred2][callIndex++].promise),
                conflictor: (c, n) => c !== n ? "queue" : "attach",
                getCapabilities: () => noopCapabilities,
            });

            const h1 = ep.invoke("A");
            const h2 = ep.invoke("B");

            deferred1.reject(new Error("A-crashed"));
            await h1.result.catch(() => {});
            await new Promise((r) => setImmediate(r));

            // Queued run B should have started
            expect(callIndex).toBe(2);
            deferred2.resolve("B-ok");
            await expect(h2.result).resolves.toBe("B-ok");
        });
    });

    describe("error propagation", () => {
        it("propagates errors to the initiator", async () => {
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => Promise.reject(new Error("failure"))),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            const handle = ep.invoke(undefined);

            await expect(handle.result).rejects.toThrow("failure");
        });

        it("propagates errors to all attachers", async () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => deferred.promise),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            const h1 = ep.invoke(undefined);
            const h2 = ep.invoke(undefined);
            const h3 = ep.invoke(undefined);

            deferred.reject(new Error("pipeline crashed"));

            await Promise.all([
                expect(h1.result).rejects.toThrow("pipeline crashed"),
                expect(h2.result).rejects.toThrow("pipeline crashed"),
                expect(h3.result).rejects.toThrow("pipeline crashed"),
            ]);
        });

        it("allows a fresh run after a crash", async () => {
            let fail = true;
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() =>
                    fail ? Promise.reject(new Error("crash")) : Promise.resolve("fresh")
                ),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            const h1 = ep.invoke(undefined);
            await h1.result.catch(() => {});

            fail = false;
            const h2 = ep.invoke(undefined);
            expect(h2.isInitiator).toBe(true);
            await expect(h2.result).resolves.toBe("fresh");
        });

        it("allows a fresh run after a crash that propagated to attachers", async () => {
            const deferred = makeDeferred();
            let fail = true;
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() =>
                    fail ? deferred.promise : Promise.resolve("new-run")
                ),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            const h1 = ep.invoke(undefined);
            const h2 = ep.invoke(undefined);

            deferred.reject(new Error("crash"));
            await Promise.all([
                h1.result.catch(() => {}),
                h2.result.catch(() => {}),
            ]);

            fail = false;
            const h3 = ep.invoke(undefined);
            expect(h3.isInitiator).toBe(true);
            await expect(h3.result).resolves.toBe("new-run");
        });
    });

    describe("isExclusiveProcess type guard", () => {
        it("returns true for an ExclusiveProcess", () => {
            expect(isExclusiveProcess(makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => Promise.resolve()),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            }))).toBe(true);
        });

        it("returns false for non-ExclusiveProcess values", () => {
            expect(isExclusiveProcess(null)).toBe(false);
            expect(isExclusiveProcess(undefined)).toBe(false);
            expect(isExclusiveProcess({})).toBe(false);
            expect(isExclusiveProcess("string")).toBe(false);
            expect(isExclusiveProcess(42)).toBe(false);
        });
    });

    describe("isExclusiveProcessHandle type guard", () => {
        it("returns true for an initiator handle returned by invoke", () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => deferred.promise),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });
            const handle = ep.invoke(undefined);
            expect(isExclusiveProcessHandle(handle)).toBe(true);
            deferred.resolve();
        });

        it("returns true for an attacher handle returned by invoke", () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => deferred.promise),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });
            ep.invoke(undefined);
            const attacher = ep.invoke(undefined);
            expect(isExclusiveProcessHandle(attacher)).toBe(true);
            deferred.resolve();
        });

        it("returns false for non-handle values", () => {
            expect(isExclusiveProcessHandle(null)).toBe(false);
            expect(isExclusiveProcessHandle(undefined)).toBe(false);
            expect(isExclusiveProcessHandle({})).toBe(false);
            expect(isExclusiveProcessHandle("string")).toBe(false);
        });
    });

    describe("isRunning", () => {
        it("returns false when the process is idle", () => {
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => Promise.resolve()),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });
            expect(ep.isRunning()).toBe(false);
        });

        it("returns true while a computation is active", () => {
            const deferred = makeDeferred();
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => deferred.promise),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });
            ep.invoke(undefined);
            expect(ep.isRunning()).toBe(true);
            deferred.resolve();
        });

        it("returns false after a successful run completes", async () => {
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => Promise.resolve("done")),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });
            await ep.invoke(undefined).result;
            expect(ep.isRunning()).toBe(false);
        });

        it("returns false after a failed run completes", async () => {
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(() => Promise.reject(new Error("fail"))),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });
            await ep.invoke(undefined).result.catch(() => {});
            expect(ep.isRunning()).toBe(false);
        });
    });

    describe("sequential runs", () => {
        it("allows a second run after the first completes", async () => {
            let runCount = 0;
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(async () => ++runCount),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });

            const h1 = ep.invoke(undefined);
            await h1.result;

            const h2 = ep.invoke(undefined);
            await h2.result;

            expect(runCount).toBe(2);
            expect(h1.isInitiator).toBe(true);
            expect(h2.isInitiator).toBe(true);
        });

        it("processes sequential invocations correctly", async () => {
            let runCount = 0;
            const ep = makeExclusiveProcess({
                initialState: undefined,
                procedure: simpleProcedure(async () => ++runCount),
                conflictor: () => "attach",
                getCapabilities: () => noopCapabilities,
            });
            const results = [];

            for (let i = 0; i < 3; i++) {
                await ep.invoke(undefined).result.then((v) => results.push(v));
            }

            expect(results).toEqual([1, 2, 3]);
        });
    });
});
