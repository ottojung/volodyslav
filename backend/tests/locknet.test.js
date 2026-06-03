/**
 * Tests for LockNet — the standalone fair resource scheduler.
 */

const { makeLockNet } = require("../src/locknet/class");

/**
 * Create a promise that resolves when `resolve` is called, plus a
 * `waitForEnter` promise that resolves when `run()` has been entered
 * (the resource-acquisition phase is complete).
 *
 * @returns {{ enter: Promise<void>, enterResolve: () => void, exitResolve: () => void, exit: Promise<void>, waitForEnter: Promise<void>, waitForEnterResolve: () => void }}
 */
function makeControlledProcedure() {
    let enterResolve;
    let exitResolve;
    let waitForEnterResolve;
    const enter = new Promise((resolve) => { enterResolve = resolve; });
    const exit = new Promise((resolve) => { exitResolve = resolve; });
    const waitForEnter = new Promise((resolve) => { waitForEnterResolve = resolve; });
    return {
        enter,
        enterResolve,
        exit,
        exitResolve,
        waitForEnter,
        waitForEnterResolve,
        async run() {
            waitForEnterResolve();
            await enter;
        },
    };
}

/**
 * Return a promise that resolves after at least `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("LockNet", () => {
    describe("basic mutex exclusion", () => {
        test("single mutex allows one holder at a time", async () => {
            const lockNet = makeLockNet();

            const proc = makeControlledProcedure();
            const runPromise = lockNet.run(
                [{ kind: "mutex", key: "resource-a" }],
                () => proc.run(),
            );
            await proc.waitForEnter;

            // Second attempt for same key must wait
            let secondRan = false;
            const secondPromise = lockNet.run(
                [{ kind: "mutex", key: "resource-a" }],
                async () => { secondRan = true; },
            );
            await delay(10);
            expect(secondRan).toBe(false);

            // Release first
            proc.enterResolve();
            await runPromise;
            await secondPromise;
            expect(secondRan).toBe(true);
        });

        test("different mutex keys run concurrently", async () => {
            const lockNet = makeLockNet();

            const procA = makeControlledProcedure();
            const procB = makeControlledProcedure();

            const promiseA = lockNet.run(
                [{ kind: "mutex", key: "a" }],
                () => procA.run(),
            );
            await procA.waitForEnter;

            // Different key should not block — procB enters while procA holds "a"
            const promiseB = lockNet.run(
                [{ kind: "mutex", key: "b" }],
                () => procB.run(),
            );
            await procB.waitForEnter;
            expect(procB.waitForEnter).toBeDefined();

            procA.enterResolve();
            procB.enterResolve();
            await Promise.all([promiseA, promiseB]);
        });
    });

    describe("mode resource compatibility", () => {
        test("same mode runs concurrently", async () => {
            const lockNet = makeLockNet();

            const proc1 = makeControlledProcedure();
            const proc2 = makeControlledProcedure();

            const p1 = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "observe" }],
                () => proc1.run(),
            );
            await proc1.waitForEnter;

            // Same mode should enter immediately
            const p2 = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "observe" }],
                () => proc2.run(),
            );
            await proc2.waitForEnter;
            expect(p2).toBeInstanceOf(Promise);

            proc1.enterResolve();
            proc2.enterResolve();
            await Promise.all([p1, p2]);
        });

        test("different modes block each other", async () => {
            const lockNet = makeLockNet();

            const proc1 = makeControlledProcedure();
            const p1 = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "observe" }],
                () => proc1.run(),
            );
            await proc1.waitForEnter;

            // Different mode should NOT enter
            let secondRan = false;
            const p2 = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "pull" }],
                async () => { secondRan = true; },
            );
            await delay(10);
            expect(secondRan).toBe(false);

            proc1.enterResolve();
            await p1;
            await p2;
            expect(secondRan).toBe(true);
        });
    });

    describe("pull concurrency for different nodes", () => {
        test("pulls for different nodes may overlap", async () => {
            const lockNet = makeLockNet();

            const procA = makeControlledProcedure();
            const procB = makeControlledProcedure();

            const pA = lockNet.run([
                { kind: "mode", key: "activity", mode: "pull" },
                { kind: "mutex", key: "node-A" },
            ], () => procA.run());
            await procA.waitForEnter;

            const pB = lockNet.run([
                { kind: "mode", key: "activity", mode: "pull" },
                { kind: "mutex", key: "node-B" },
            ], () => procB.run());
            await procB.waitForEnter;
            // Both entered concurrently (different node keys don't block)
            expect(procB.waitForEnter).toBeDefined();

            procA.enterResolve();
            procB.enterResolve();
            await Promise.all([pA, pB]);
        });

        test("same-node pulls serialize", async () => {
            const lockNet = makeLockNet();

            const proc1 = makeControlledProcedure();
            const p1 = lockNet.run([
                { kind: "mode", key: "activity", mode: "pull" },
                { kind: "mutex", key: "node-X" },
            ], () => proc1.run());
            await proc1.waitForEnter;

            let secondRan = false;
            const p2 = lockNet.run([
                { kind: "mode", key: "activity", mode: "pull" },
                { kind: "mutex", key: "node-X" },
            ], async () => { secondRan = true; });
            await delay(10);
            expect(secondRan).toBe(false);

            proc1.enterResolve();
            await p1;
            await p2;
            expect(secondRan).toBe(true);
        });
    });

    describe("pull excludes observe", () => {
        test("pull blocks subsequent observe", async () => {
            const lockNet = makeLockNet();

            const procPull = makeControlledProcedure();
            const pPull = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "pull" }],
                () => procPull.run(),
            );
            await procPull.waitForEnter;

            let observeRan = false;
            const pObserve = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "observe" }],
                async () => { observeRan = true; },
            );
            await delay(10);
            expect(observeRan).toBe(false);

            procPull.enterResolve();
            await pPull;
            await pObserve;
            expect(observeRan).toBe(true);
        });

        test("observe blocks subsequent pull", async () => {
            const lockNet = makeLockNet();

            const procObserve = makeControlledProcedure();
            const pObserve = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "observe" }],
                () => procObserve.run(),
            );
            await procObserve.waitForEnter;

            let pullRan = false;
            const pPull = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "pull" }],
                async () => { pullRan = true; },
            );
            await delay(10);
            expect(pullRan).toBe(false);

            procObserve.enterResolve();
            await pObserve;
            await pPull;
            expect(pullRan).toBe(true);
        });
    });

    describe("exclusive excludes everything", () => {
        test("exclusive blocks observe", async () => {
            const lockNet = makeLockNet();

            const procEx = makeControlledProcedure();
            const pEx = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "exclusive" }],
                () => procEx.run(),
            );
            await procEx.waitForEnter;

            let observeRan = false;
            const pObserve = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "observe" }],
                async () => { observeRan = true; },
            );
            await delay(10);
            expect(observeRan).toBe(false);

            procEx.enterResolve();
            await pEx;
            await pObserve;
            expect(observeRan).toBe(true);
        });

        test("exclusive blocks pull", async () => {
            const lockNet = makeLockNet();

            const procEx = makeControlledProcedure();
            const pEx = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "exclusive" }],
                () => procEx.run(),
            );
            await procEx.waitForEnter;

            let pullRan = false;
            const pPull = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "pull" }],
                async () => { pullRan = true; },
            );
            await delay(10);
            expect(pullRan).toBe(false);

            procEx.enterResolve();
            await pEx;
            await pPull;
            expect(pullRan).toBe(true);
        });

        test("exclusive blocks another exclusive", async () => {
            const lockNet = makeLockNet();

            // Exclusivity requires a mutex alongside the exclusive mode,
            // matching the real withExclusiveLock pattern.
            const procEx1 = makeControlledProcedure();
            const pEx1 = lockNet.run([
                { kind: "mode", key: "activity", mode: "exclusive" },
                { kind: "mutex", key: "exclusive-mutex" },
            ], () => procEx1.run());
            await procEx1.waitForEnter;

            let ex2Ran = false;
            const pEx2 = lockNet.run([
                { kind: "mode", key: "activity", mode: "exclusive" },
                { kind: "mutex", key: "exclusive-mutex" },
            ], async () => { ex2Ran = true; });
            await delay(10);
            expect(ex2Ran).toBe(false);

            procEx1.enterResolve();
            await pEx1;
            await pEx2;
            expect(ex2Ran).toBe(true);
        });

        test("observe blocks subsequent exclusive", async () => {
            const lockNet = makeLockNet();

            const procObserve = makeControlledProcedure();
            const pObserve = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "observe" }],
                () => procObserve.run(),
            );
            await procObserve.waitForEnter;

            let exRan = false;
            const pEx = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "exclusive" }],
                async () => { exRan = true; },
            );
            await delay(10);
            expect(exRan).toBe(false);

            procObserve.enterResolve();
            await pObserve;
            await pEx;
            expect(exRan).toBe(true);
        });

        test("pull blocks subsequent exclusive", async () => {
            const lockNet = makeLockNet();

            const procPull = makeControlledProcedure();
            const pPull = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "pull" }],
                () => procPull.run(),
            );
            await procPull.waitForEnter;

            let exRan = false;
            const pEx = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "exclusive" }],
                async () => { exRan = true; },
            );
            await delay(10);
            expect(exRan).toBe(false);

            procPull.enterResolve();
            await pPull;
            await pEx;
            expect(exRan).toBe(true);
        });
    });

    describe("FIFO fairness", () => {
        test("later compatible request does not bypass queued conflicting request", async () => {
            const lockNet = makeLockNet();

            // Start a pull
            const procPull = makeControlledProcedure();
            const pPull = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "pull" }],
                () => procPull.run(),
            );
            await procPull.waitForEnter;

            // Queue an observe with controlled procedure — conflicts with active pull
            const procObserve = makeControlledProcedure();
            const pObserve = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "observe" }],
                () => procObserve.run(),
            );
            await delay(10);
            // Not entered yet because pull is active
            expect(pObserve).not.toBe(undefined);

            // Now queue another pull — compatible with the active pull but NOT
            // with the queued observe (which is earlier in the queue).
            let secondPullRan = false;
            const pSecondPull = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "pull" }],
                async () => { secondPullRan = true; },
            );
            await delay(10);

            // Second pull must NOT run because the observe is ahead of it in queue
            // and conflicts (even though the second pull is compatible with active pull).
            expect(secondPullRan).toBe(false);

            // Release the first pull — drainQueue should now admit observe, not second pull
            procPull.enterResolve();
            await pPull;

            // Wait for observe to be admitted
            await procObserve.waitForEnter;
            expect(secondPullRan).toBe(false);

            // Release observe — now second pull can run
            procObserve.enterResolve();
            await pObserve;
            await pSecondPull;
            expect(secondPullRan).toBe(true);
        });
    });

    describe("atomic admission", () => {
        test("does not hold partial resources while waiting", async () => {
            const lockNet = makeLockNet();

            // Start an observe to occupy the activity resource
            const procObserve = makeControlledProcedure();
            const pObserve = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "observe" }],
                () => procObserve.run(),
            );
            await procObserve.waitForEnter;

            // Try to acquire mode + mutex — mode conflicts with observe,
            // so the entire request must wait (atomic).
            let combinedRan = false;
            const pCombined = lockNet.run([
                { kind: "mode", key: "activity", mode: "pull" },
                { kind: "mutex", key: "node-A" },
            ], async () => { combinedRan = true; });
            await delay(10);
            expect(combinedRan).toBe(false);

            // Release observe
            procObserve.enterResolve();
            await pObserve;

            // Now combined should be able to run
            await pCombined;
            expect(combinedRan).toBe(true);
        });
    });

    describe("exception safety", () => {
        test("releases all resources when procedure throws", async () => {
            const lockNet = makeLockNet();

            const testError = new Error("intentional failure");
            await expect(
                lockNet.run(
                    [{ kind: "mutex", key: "resource-A" }],
                    async () => { throw testError; },
                ),
            ).rejects.toThrow("intentional failure");

            // After the failure, the resource should be released — acquire it again
            let ran = false;
            await lockNet.run(
                [{ kind: "mutex", key: "resource-A" }],
                async () => { ran = true; },
            );
            expect(ran).toBe(true);
        });

        test("allows re-entry after exception in mode resource", async () => {
            const lockNet = makeLockNet();

            await expect(
                lockNet.run(
                    [{ kind: "mode", key: "activity", mode: "observe" }],
                    async () => { throw new Error("fail"); },
                ),
            ).rejects.toThrow("fail");

            // Should be able to acquire again
            let ran = false;
            await lockNet.run(
                [{ kind: "mode", key: "activity", mode: "observe" }],
                async () => { ran = true; },
            );
            expect(ran).toBe(true);
        });
    });

    describe("debug snapshot", () => {
        test("returns correct queue state", async () => {
            const lockNet = makeLockNet();

            const proc = makeControlledProcedure();
            const p1 = lockNet.run(
                [{ kind: "mutex", key: "x" }],
                () => proc.run(),
            );
            await proc.waitForEnter;

            // Queue a second conflicting request
            const p2 = lockNet.run(
                [{ kind: "mutex", key: "x" }],
                async () => {},
            );
            await delay(10);

            const snap = lockNet.debugSnapshot();
            expect(snap.runningTickets).toBe(1);
            expect(snap.queue).toHaveLength(1);
            expect(snap.queue[0].state).toBe("queued");

            proc.enterResolve();
            await Promise.all([p1, p2]);
        });
    });

    describe("return value passthrough", () => {
        test("returns the value from procedure", async () => {
            const lockNet = makeLockNet();
            const result = await lockNet.run(
                [{ kind: "mutex", key: "r" }],
                async () => "hello-locknet",
            );
            expect(result).toBe("hello-locknet");
        });
    });

    describe("multiple resource types combined", () => {
        test("mode + mutex request works correctly", async () => {
            const lockNet = makeLockNet();

            let ran = false;
            await lockNet.run([
                { kind: "mode", key: "g", mode: "pull" },
                { kind: "mutex", key: "node-42" },
            ], async () => { ran = true; });
            expect(ran).toBe(true);
        });
    });

    describe("randomized model test", () => {
        /**
         * Check that the safety invariants hold given the current scheduler state.
         *
         * Invariants:
         *   - If any observe is active, no pull or exclusive is active.
         *   - If any pull is active, no observe or exclusive is active.
         *   - If exclusive is active, only one exclusive is active and no
         *     observe/pull.
         *   - No mutex key has more than one holder.
         */
        function checkInvariants(snap) {
            const activeByMode = { observe: 0, pull: 0, exclusive: 0 };
            const mutexHolders = new Map();

            for (const { key, entry } of snap.activeResources) {
                if (entry.kind === "mode") {
                    if (entry.mode === "observe" || entry.mode === "pull" || entry.mode === "exclusive") {
                        activeByMode[entry.mode] = (activeByMode[entry.mode] || 0) + entry.count;
                    }
                } else if (entry.kind === "mutex") {
                    const prev = mutexHolders.get(key) || 0;
                    mutexHolders.set(key, prev + 1);
                }
            }

            // No mutex key should have more than one holder
            for (const [, count] of mutexHolders) {
                expect(count).toBeLessThanOrEqual(1);
            }

            if (activeByMode.observe > 0) {
                expect(activeByMode.pull).toBe(0);
                expect(activeByMode.exclusive).toBe(0);
            }

            if (activeByMode.pull > 0) {
                expect(activeByMode.observe).toBe(0);
                expect(activeByMode.exclusive).toBe(0);
            }

            if (activeByMode.exclusive > 0) {
                expect(activeByMode.observe).toBe(0);
                expect(activeByMode.pull).toBe(0);
                expect(activeByMode.exclusive).toBe(1);
            }
        }

        test("random operations preserve all invariants", async () => {
            const lockNet = makeLockNet();
            const nodeNames = ["A", "B", "C"];

            const running = [];

            for (let i = 0; i < 200; i++) {
                // Randomly pick an operation
                const opType = Math.floor(Math.random() * 4); // 0=observe, 1=pull, 2=exclusive, 3=mutex
                let resources;
                if (opType === 0) {
                    resources = [{ kind: "mode", key: "activity", mode: "observe" }];
                } else if (opType === 1) {
                    const node = nodeNames[Math.floor(Math.random() * nodeNames.length)];
                    resources = [
                        { kind: "mode", key: "activity", mode: "pull" },
                        { kind: "mutex", key: `node-${node}` },
                    ];
                } else if (opType === 2) {
                    resources = [
                        { kind: "mode", key: "activity", mode: "exclusive" },
                        { kind: "mutex", key: "exclusive-mutex" },
                    ];
                } else {
                    const node = nodeNames[Math.floor(Math.random() * nodeNames.length)];
                    resources = [{ kind: "mutex", key: `standalone-${node}` }];
                }

                // Possibly inject a random delay or failure
                const shouldFail = Math.random() < 0.05;
                const proc = shouldFail
                    ? async () => { throw new Error("random failure"); }
                    : async () => {
                        await delay(Math.floor(Math.random() * 5));
                    };

                const p = lockNet.run(resources, proc).catch(() => {});
                running.push(p);

                // Check invariants after each new submission
                checkInvariants(lockNet.debugSnapshot());

                // Occasionally wait for all to clear
                if (i % 50 === 49) {
                    await Promise.all(running);
                    running.length = 0;
                    checkInvariants(lockNet.debugSnapshot());
                }
            }

            // Drain all remaining operations
            await Promise.all(running);
            checkInvariants(lockNet.debugSnapshot());
            expect(lockNet.debugSnapshot().queue).toHaveLength(0);
        }, 30000);
    });

    describe("large-scale stress", () => {
        test("many concurrent operations complete without deadlock", async () => {
            const lockNet = makeLockNet();

            const workers = [];
            for (let i = 0; i < 50; i++) {
                const nodeName = String.fromCharCode(65 + (i % 10)); // A-J
                workers.push(
                    lockNet.run([
                        { kind: "mode", key: "activity", mode: "pull" },
                        { kind: "mutex", key: `node-${nodeName}` },
                    ], async () => {
                        await delay(Math.floor(Math.random() * 10));
                    }),
                );
            }

            const results = await Promise.all(workers);
            expect(results).toHaveLength(50);
        }, 15000);
    });

    describe("re-entrant calls", () => {
        test("nested run from within running callback bypasses FIFO queue", async () => {
            const lockNet = makeLockNet();

            // Use controlled procedures to track entry order precisely.
            const procOuter = makeControlledProcedure();
            const procObserve = makeControlledProcedure();

            const order = [];

            // Outer operation: acquires mode:pull, yields,
            // then makes a nested re-entrant call.
            const outerPromise = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "pull" }],
                async () => {
                    await procOuter.run();
                    // Re-entrant nested pull — must run before queued observe.
                    await lockNet.run(
                        [{ kind: "mode", key: "activity", mode: "pull" }],
                        async () => { order.push("nested"); },
                    );
                },
            );
            await procOuter.waitForEnter;

            // Queue an observe with a controlled procedure — blocked by pull.
            const observePromise = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "observe" }],
                async () => {
                    order.push("observe");
                    await procObserve.run();
                },
            );
            await delay(10);
            expect(order).toEqual([]);

            // Resume outer callback — it makes a nested re-entrant call.
            procOuter.enterResolve();

            // Yield to let microtasks drain: nested runs immediately
            // (bypasses FIFO) and releases.  Outer then completes,
            // releasing mode:pull.  Observe is then admitted.
            await delay(10);
            expect(order).toEqual(["nested", "observe"]);
            await procObserve.waitForEnter;

            // Clean up
            procObserve.enterResolve();
            await outerPromise;
            await observePromise;
        });

        test("re-entrant call that conflicts is queued at front, not behind unrelated waiters", async () => {
            const lockNet = makeLockNet();

            // Ticket-A holds mutex:A and mode:pull.
            // An unrelated observe (mode:observe) is queued.
            // Then Ticket-B (which runs concurrently, different key) makes
            // a nested re-entrant call that needs mutex:A.  That nested
            // ticket must go to the FRONT of the queue (ahead of observe).

            const procA = makeControlledProcedure();
            const procB = makeControlledProcedure();

            let nestedRan = false;

            // Ticket-A holds mutex:A
            const promiseA = lockNet.run(
                [{ kind: "mutex", key: "A" }, { kind: "mode", key: "activity", mode: "pull" }],
                () => procA.run(),
            );
            await procA.waitForEnter;

            // Queue an unrelated observe — blocked by mode:pull
            let observeRan = false;
            const observePromise = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "observe" }],
                async () => { observeRan = true; },
            );
            await delay(10);
            expect(observeRan).toBe(false);

            // Ticket-B acquires key B (no conflict with A), then makes
            // a nested call for mutex:A — re-entrant but conflicting.
            const promiseB = lockNet.run(
                [{ kind: "mutex", key: "B" }],
                async () => {
                    await procB.run();
                    // Nested call for mutex:A — conflicting (held by A),
                    // but re-entrant (inside B's callback).
                    await lockNet.run(
                        [{ kind: "mutex", key: "A" }],
                        async () => { nestedRan = true; },
                    );
                },
            );
            await procB.waitForEnter;

            // B makes its nested call, which conflicts on mutex:A
            procB.enterResolve();

            await delay(10);
            // Nested is blocked on mutex:A, observe is blocked on mode:pull
            expect(nestedRan).toBe(false);
            expect(observeRan).toBe(false);

            // Verify nested ticket is ahead of observe in the queue
            const snapshot = lockNet.debugSnapshot();
            const queueResources = snapshot.queue.map(t =>
                t.resources.map(r => r.kind + ':' + r.key)
            );
            // First queued ticket is the re-entrant nested call for mutex:A
            expect(queueResources[0]).toContain('mutex:A');

            // Release A → A releases mutex:A → nested (at front) admitted
            procA.enterResolve();
            await promiseA;

            await delay(10);
            expect(nestedRan).toBe(true);

            // After nested releases, observe is unblocked
            await promiseB;
            await observePromise;
            expect(observeRan).toBe(true);
        });

        test("independent concurrent calls are NOT treated as re-entrant", async () => {
            const lockNet = makeLockNet();

            const procFirst = makeControlledProcedure();
            const firstPromise = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "pull" }],
                () => procFirst.run(),
            );
            await procFirst.waitForEnter;

            // Queue an observe that conflicts with active pull
            let observeRan = false;
            const observePromise = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "observe" }],
                async () => { observeRan = true; },
            );
            await delay(10);
            expect(observeRan).toBe(false);

            // A second compatible pull submitted from the test (NOT inside the
            // outer callback) must NOT bypass the FIFO queue.
            let secondPullRan = false;
            const secondPullPromise = lockNet.run(
                [{ kind: "mode", key: "activity", mode: "pull" }],
                async () => { secondPullRan = true; },
            );
            await delay(10);
            expect(secondPullRan).toBe(false);

            // Release the first pull
            procFirst.enterResolve();
            await firstPromise;

            // Observe runs first (ahead in the queue)
            await observePromise;
            expect(observeRan).toBe(true);

            // Then the second pull runs
            await secondPullPromise;
            expect(secondPullRan).toBe(true);
        });
    });
});
