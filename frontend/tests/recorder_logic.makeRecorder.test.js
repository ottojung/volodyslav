/**
 * Unit tests for makeRecorder PCM scheduler logic.
 *
 * Covers: PCM scheduler tick timing, pause/resume accounting,
 * final PCM drain on stop(), and ondataavailable blob collection.
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
let onPcmFragmentSpy;

import { makeRecorder, FRAGMENT_MS } from "../src/AudioDiary/recorder_logic.js";

beforeEach(() => {
    jest.useFakeTimers();

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

    onPcmFragmentSpy = jest.fn();
});

afterEach(() => {
    jest.useRealTimers();
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
        onPcmFragment: onPcmFragmentSpy,
    });
    await recorder.start();
    return recorder;
}

// ─── Tests: MediaRecorder started without timeslice ──────────────────────────

describe("makeRecorder: no-timeslice MediaRecorder start", () => {
    it("calls MediaRecorder.start() with no arguments", async () => {
        const recorder = await startRecorder();
        expect(instance.start).toHaveBeenCalledWith();
        recorder.discard();
    });
});

// ─── Tests: PCM scheduler tick timing ────────────────────────────────────────

describe("makeRecorder: PCM scheduler tick timing", () => {
    it("fires onPcmFragment after FRAGMENT_MS of active time", async () => {
        const recorder = await startRecorder();
        // Advance both the fake clock and the mocked performance.now
        mockNow = FRAGMENT_MS;
        jest.advanceTimersByTime(FRAGMENT_MS);

        expect(onPcmFragmentSpy).toHaveBeenCalledTimes(1);
        expect(onPcmFragmentSpy).toHaveBeenCalledWith(0, FRAGMENT_MS, null);
        recorder.discard();
    });

    it("second tick starts where the first ended", async () => {
        const recorder = await startRecorder();
        mockNow = FRAGMENT_MS;
        jest.advanceTimersByTime(FRAGMENT_MS);

        mockNow = FRAGMENT_MS * 2;
        jest.advanceTimersByTime(FRAGMENT_MS);

        expect(onPcmFragmentSpy).toHaveBeenCalledTimes(2);
        expect(onPcmFragmentSpy).toHaveBeenNthCalledWith(
            2,
            FRAGMENT_MS,
            FRAGMENT_MS * 2,
            null
        );
        recorder.discard();
    });

    it("does not fire onPcmFragment before FRAGMENT_MS elapses", async () => {
        const recorder = await startRecorder();
        mockNow = FRAGMENT_MS - 1;
        jest.advanceTimersByTime(FRAGMENT_MS - 1);
        expect(onPcmFragmentSpy).not.toHaveBeenCalled();
        recorder.discard();
    });
});

// ─── Tests: PCM scheduler pause/resume ───────────────────────────────────────

describe("makeRecorder: PCM scheduler pauses during pause()", () => {
    it("does not fire ticks while paused", async () => {
        const recorder = await startRecorder();
        // 2 s active → pause
        mockNow = 2000;
        recorder.pause();
        // Advance wall clock another FRAGMENT_MS while paused — should not fire
        mockNow = 2000 + FRAGMENT_MS;
        jest.advanceTimersByTime(FRAGMENT_MS);
        expect(onPcmFragmentSpy).not.toHaveBeenCalled();
        recorder.discard();
    });

    it("resumes ticks from the correct active-time position after resume()", async () => {
        const recorder = await startRecorder();
        // 5 s active → pause
        mockNow = 5000;
        recorder.pause();
        // 3 s paused
        mockNow = 8000;
        recorder.resume();
        // Fire first scheduler tick: 10 s more of active time → total active = 15 s
        mockNow = 8000 + FRAGMENT_MS;
        jest.advanceTimersByTime(FRAGMENT_MS);

        // After 5 s active before pause + FRAGMENT_MS active after resume:
        // fragStart = 0, fragEnd = 5000 + FRAGMENT_MS = 15000
        expect(onPcmFragmentSpy).toHaveBeenCalledTimes(1);
        expect(onPcmFragmentSpy).toHaveBeenCalledWith(0, 5000 + FRAGMENT_MS, null);
        recorder.discard();
    });
});

// ─── Tests: final PCM drain on stop() ────────────────────────────────────────

describe("makeRecorder: final PCM drain on stop()", () => {
    it("drains trailing partial window when stop() is called", async () => {
        const recorder = await startRecorder();
        // 7 s active — less than one full FRAGMENT_MS
        mockNow = 7000;
        recorder.stop();

        // The final drain should cover [0, 7000]
        expect(onPcmFragmentSpy).toHaveBeenCalledTimes(1);
        expect(onPcmFragmentSpy).toHaveBeenCalledWith(0, 7000, null);
    });

    it("drains the window after the last scheduler tick on stop()", async () => {
        const recorder = await startRecorder();
        // One full scheduler tick fires at 10 s
        mockNow = FRAGMENT_MS;
        jest.advanceTimersByTime(FRAGMENT_MS);
        expect(onPcmFragmentSpy).toHaveBeenCalledTimes(1);

        // 3 more seconds pass, then stop
        mockNow = FRAGMENT_MS + 3000;
        recorder.stop();

        expect(onPcmFragmentSpy).toHaveBeenCalledTimes(2);
        expect(onPcmFragmentSpy).toHaveBeenNthCalledWith(
            2,
            FRAGMENT_MS,
            FRAGMENT_MS + 3000,
            null
        );
    });

    it("does not drain if no active time has elapsed since last tick", async () => {
        const recorder = await startRecorder();
        // Tick fires exactly at FRAGMENT_MS
        mockNow = FRAGMENT_MS;
        jest.advanceTimersByTime(FRAGMENT_MS);
        // Immediately stop at same active timestamp (no new active time)
        recorder.stop();
        // Only the one tick should have fired; stop() drain is a no-op
        expect(onPcmFragmentSpy).toHaveBeenCalledTimes(1);
    });

    it("final drain on stop() while paused uses active time at pause", async () => {
        const recorder = await startRecorder();
        // 5 s active → pause
        mockNow = 5000;
        recorder.pause();
        // Time continues but recorder is paused; stop is called 3 s later (paused)
        mockNow = 8000;
        recorder.stop();

        // Active time at stop = 5000 ms (paused time excluded)
        expect(onPcmFragmentSpy).toHaveBeenCalledTimes(1);
        expect(onPcmFragmentSpy).toHaveBeenCalledWith(0, 5000, null);
    });
});

// ─── Tests: ondataavailable blob collection ───────────────────────────────────

describe("makeRecorder: ondataavailable collects blobs only", () => {
    it("pushes non-empty blobs to _chunks without calling onPcmFragment", async () => {
        const recorder = await startRecorder();
        // Simulate a dataavailable event (e.g. from requestData or stop)
        fireData(instance, new Blob(["audio"]));
        // onPcmFragment should NOT be triggered by ondataavailable
        expect(onPcmFragmentSpy).not.toHaveBeenCalled();
        recorder.discard();
    });

    it("ignores empty blobs", async () => {
        const recorder = await startRecorder();
        fireData(instance, new Blob([]));
        // No assertion needed beyond no error; just verify it doesn't crash
        expect(onPcmFragmentSpy).not.toHaveBeenCalled();
        recorder.discard();
    });
});

// ─── Tests: requestData() as durability hint ─────────────────────────────────

describe("makeRecorder: requestData() is a fire-and-forget durability hint", () => {
    it("returns a resolved promise", async () => {
        const recorder = await startRecorder();
        await expect(recorder.requestData()).resolves.toBeUndefined();
        recorder.discard();
    });

    it("calls mediaRecorder.requestData()", async () => {
        const recorder = await startRecorder();
        await recorder.requestData();
        expect(instance.requestData).toHaveBeenCalled();
        recorder.discard();
    });

    it("does not trigger onPcmFragment", async () => {
        const recorder = await startRecorder();
        instance.requestData.mockImplementationOnce(() => {
            fireData(instance, new Blob(["partial"]));
        });
        await recorder.requestData();
        expect(onPcmFragmentSpy).not.toHaveBeenCalled();
        recorder.discard();
    });
});

