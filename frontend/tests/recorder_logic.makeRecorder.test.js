/**
 * Unit tests for makeRecorder timestamp logic.
 *
 * Covers: regular timeslice, requestData() flush, stop() flush, and
 * pause/resume wall-clock accounting.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────


/** Build a fake MediaStream whose tracks can be stopped. */
function makeFakeStream() {
    const track = { stop: jest.fn() };
    return { getTracks: () => [track] };
}

/**
 * Create a controllable mock MediaRecorder instance and factory.
 * `state` starts at "recording"; callers can mutate it to simulate events.
 */
function makeMockMediaRecorder() {
    const instance = {
        state: "recording",
        start: jest.fn(),
        stop: jest.fn(),
        pause: jest.fn(),
        resume: jest.fn(),
        requestData: jest.fn(),
        ondataavailable: /** @type {Function | null} */ (null),
        onstop: /** @type {Function | null} */ (null),
        onerror: /** @type {Function | null} */ (null),
    };
    const MockMR = jest.fn(() => instance);
    MockMR.isTypeSupported = jest.fn(() => false);
    return { instance, MockMR };
}

/** Fire a dataavailable-like event on the mock instance. */
function fireData(instance, data) {
    if (typeof instance.ondataavailable === "function") {
        instance.ondataavailable({ data });
    }
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

let origMediaRecorder;
let origNavigator;
let mockNow;
let nowSpy;
let instance;
let MockMR;
let onChunkSpy;

import { makeRecorder, FRAGMENT_MS } from "../src/AudioDiary/recorder_logic.js";

beforeEach(() => {
    mockNow = 0;
    // Spy on the real performance.now() so that recorder_logic.js uses our value
    nowSpy = jest.spyOn(performance, "now").mockImplementation(() => mockNow);

    origNavigator = global.navigator;
    Object.defineProperty(global, "navigator", {
        value: {
            mediaDevices: {
                getUserMedia: jest.fn().mockResolvedValue(makeFakeStream()),
            },
        },
        configurable: true,
        writable: true,
    });

    const mock = makeMockMediaRecorder();
    instance = mock.instance;
    MockMR = mock.MockMR;

    origMediaRecorder = global.MediaRecorder;
    Object.defineProperty(global, "MediaRecorder", {
        value: MockMR,
        configurable: true,
        writable: true,
    });

    onChunkSpy = jest.fn();
});

afterEach(() => {
    nowSpy.mockRestore();
    Object.defineProperty(global, "navigator", {
        value: origNavigator,
        configurable: true,
        writable: true,
    });
    Object.defineProperty(global, "MediaRecorder", {
        value: origMediaRecorder,
        configurable: true,
        writable: true,
    });
});

async function startRecorder() {
    const recorder = makeRecorder({
        onStateChange: jest.fn(),
        onStop: jest.fn(),
        onError: jest.fn(),
        onAnalyser: jest.fn(),
        onChunk: onChunkSpy,
    });
    await recorder.start();
    return recorder;
}

// ─── Tests: regular timeslice events ─────────────────────────────────────────

describe("makeRecorder: regular timeslice timestamps", () => {
    it("first fragment has startMs=0 and endMs=FRAGMENT_MS", async () => {
        const recorder = await startRecorder();
        fireData(instance, new Blob(["a"]));
        expect(onChunkSpy).toHaveBeenCalledTimes(1);
        expect(onChunkSpy).toHaveBeenCalledWith(
            expect.any(Blob),
            0,
            FRAGMENT_MS,
            null
        );
        recorder.discard();
    });

    it("second fragment starts where first ended", async () => {
        const recorder = await startRecorder();
        fireData(instance, new Blob(["a"]));
        fireData(instance, new Blob(["b"]));
        expect(onChunkSpy).toHaveBeenNthCalledWith(
            2,
            expect.any(Blob),
            FRAGMENT_MS,
            FRAGMENT_MS * 2,
            null
        );
        recorder.discard();
    });

    it("ignores empty blobs", async () => {
        const recorder = await startRecorder();
        fireData(instance, new Blob([])); // empty — size 0
        fireData(instance, new Blob(["a"]));
        expect(onChunkSpy).toHaveBeenCalledTimes(1);
        expect(onChunkSpy).toHaveBeenCalledWith(expect.any(Blob), 0, FRAGMENT_MS, null);
        recorder.discard();
    });
});

// ─── Tests: requestData() forced flush ───────────────────────────────────────

describe("makeRecorder: requestData() flush timestamps", () => {
    it("uses wall-clock elapsed time for requestData() flush", async () => {
        // Recording starts at t=0
        const recorder = await startRecorder();
        // Advance clock to 3 s, then trigger a requestData() flush
        mockNow = 3000;
        instance.requestData.mockImplementationOnce(() => {
            fireData(instance, new Blob(["flush"]));
        });
        await recorder.requestData();
        // endMs should reflect 3 s of wall-clock elapsed time
        expect(onChunkSpy).toHaveBeenCalledWith(
            expect.any(Blob),
            0,   // fragStart (counter not yet incremented)
            3000, // wall-clock elapsed (3000 - 0)
            null
        );
        recorder.discard();
    });

    it("clamps requestData() endMs to fragStart when wall-clock is behind", async () => {
        // First fire a regular timeslice to advance the counter to FRAGMENT_MS
        const recorder = await startRecorder();
        fireData(instance, new Blob(["ts1"])); // counter → FRAGMENT_MS (10 000)
        // Wall clock is only 5 s but counter is at 10 s
        mockNow = 5000;
        instance.requestData.mockImplementationOnce(() => {
            fireData(instance, new Blob(["flush"]));
        });
        await recorder.requestData();
        // endMs must be clamped to ≥ startMs (= FRAGMENT_MS)
        const [, startMs, endMs] = onChunkSpy.mock.calls[1];
        expect(endMs).toBeGreaterThanOrEqual(startMs);
        recorder.discard();
    });
});

// ─── Tests: stop() flush timestamps ──────────────────────────────────────────

describe("makeRecorder: stop() flush timestamps", () => {
    it("uses wall-clock for stop()-triggered dataavailable", async () => {
        // Recording starts at t=0; 7 s elapses before stop fires
        const recorder = await startRecorder();
        mockNow = 7000;
        // MediaRecorder.state becomes "inactive" before ondataavailable fires
        instance.state = "inactive";
        fireData(instance, new Blob(["stop-data"]));
        expect(onChunkSpy).toHaveBeenCalledWith(
            expect.any(Blob),
            0,    // fragStart
            7000, // wall-clock elapsed
            null
        );
        recorder.discard();
    });

    it("stop() flush after regular timeslice advances correctly", async () => {
        // Regular timeslice at t=10 s
        const recorder = await startRecorder();
        mockNow = 10000;
        fireData(instance, new Blob(["ts"]));
        expect(onChunkSpy).toHaveBeenNthCalledWith(
            1, expect.any(Blob), 0, FRAGMENT_MS, null
        );
        // Partial stop fragment at t=13 s
        mockNow = 13000;
        instance.state = "inactive";
        fireData(instance, new Blob(["stop"]));
        expect(onChunkSpy).toHaveBeenNthCalledWith(
            2, expect.any(Blob), FRAGMENT_MS, 13000, null
        );
        recorder.discard();
    });
});

// ─── Tests: pause / resume wall-clock accounting ─────────────────────────────

describe("makeRecorder: pause/resume wall-clock accounting", () => {
    it("excludes paused duration from requestData() wall-clock", async () => {
        // 5 s active → 3 s paused → 2 s active = 7 s total active
        const recorder = await startRecorder();
        mockNow = 5000;
        recorder.pause();          // paused at 5 s
        mockNow = 8000;
        recorder.resume();         // resumed at 8 s → 3 s paused accumulated
        mockNow = 10000;
        instance.requestData.mockImplementationOnce(() => {
            fireData(instance, new Blob(["p"]));
        });
        await recorder.requestData();
        // Active = 10 000 - 0 - 3 000 (paused) = 7 000 ms
        expect(onChunkSpy).toHaveBeenCalledWith(expect.any(Blob), 0, 7000, null);
        recorder.discard();
    });

    it("regular timeslices are counter-based even after pause/resume", async () => {
        const recorder = await startRecorder();
        // Timeslice while recording
        fireData(instance, new Blob(["r"]));
        expect(onChunkSpy).toHaveBeenCalledWith(
            expect.any(Blob), 0, FRAGMENT_MS, null
        );
        // Pause, then fire another regular timeslice
        recorder.pause();
        instance.state = "paused";
        fireData(instance, new Blob(["p"]));
        expect(onChunkSpy).toHaveBeenNthCalledWith(
            2, expect.any(Blob), FRAGMENT_MS, FRAGMENT_MS * 2, null
        );
        recorder.discard();
    });
});
