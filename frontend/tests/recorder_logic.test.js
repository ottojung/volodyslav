/**
 * Unit tests for recorder_helpers utilities.
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

let originalMediaRecorder;

beforeAll(() => {
    originalMediaRecorder = global.MediaRecorder;
    // Provide a mock MediaRecorder with isTypeSupported
    const MockMR = class {};
    MockMR.isTypeSupported = jest.fn((mime) => mime.includes("webm"));
    global.MediaRecorder = MockMR;
});

afterAll(() => {
    global.MediaRecorder = originalMediaRecorder;
});

// ─── Imports ─────────────────────────────────────────────────────────────────

import {
    chooseMimeType,
    combineChunks,
    mediaRecorderErrorMessage,
} from "../src/AudioDiary/recorder_helpers.js";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("recorder_helpers: chooseMimeType", () => {
    it("returns a string", () => {
        const mime = chooseMimeType();
        expect(typeof mime).toBe("string");
    });

    it("returns empty string when MediaRecorder is unavailable", () => {
        const originalMR = global.MediaRecorder;
        try {
            Object.defineProperty(global, "MediaRecorder", {
                value: undefined,
                configurable: true,
                writable: true,
            });
            expect(chooseMimeType()).toBe("");
        } finally {
            Object.defineProperty(global, "MediaRecorder", {
                value: originalMR,
                configurable: true,
                writable: true,
            });
        }
    });

    it("returns empty string when isTypeSupported is not a function", () => {
        const originalMR = global.MediaRecorder;
        try {
            const mr = class {};
            Object.defineProperty(global, "MediaRecorder", {
                value: mr,
                configurable: true,
                writable: true,
            });
            expect(chooseMimeType()).toBe("");
        } finally {
            Object.defineProperty(global, "MediaRecorder", {
                value: originalMR,
                configurable: true,
                writable: true,
            });
        }
    });
});

describe("recorder_helpers: combineChunks", () => {
    it("combines multiple Blobs into one Blob", () => {
        const chunks = [
            new Blob(["hello "], { type: "audio/webm" }),
            new Blob(["world"], { type: "audio/webm" }),
        ];
        const combined = combineChunks(chunks, "audio/webm");
        expect(combined).toBeInstanceOf(Blob);
        expect(combined.size).toBe(11);
        expect(combined.type).toBe("audio/webm");
    });

    it("uses a fallback type when mimeType is empty", () => {
        const chunks = [new Blob(["data"])];
        const combined = combineChunks(chunks, "");
        expect(combined.type).toBe("audio/webm");
    });

    it("preserves the given MIME type", () => {
        const chunks = [new Blob(["data"])];
        const combined = combineChunks(chunks, "audio/ogg");
        expect(combined.type).toBe("audio/ogg");
    });
});

describe("recorder_helpers: mediaRecorderErrorMessage", () => {
    it("extracts message from Error instance", () => {
        expect(mediaRecorderErrorMessage(new Error("boom"))).toBe("boom");
    });

    it("extracts message from event-like payload with error field", () => {
        expect(
            mediaRecorderErrorMessage({ error: { message: "inner failure" } })
        ).toBe("inner failure");
    });

    it("falls back to unknown message", () => {
        expect(mediaRecorderErrorMessage(undefined)).toBe(
            "Unknown MediaRecorder error"
        );
    });
});
