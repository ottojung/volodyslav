/**
 * Unit tests for recording_storage.js
 */

import {
    saveSessionId,
    loadSessionId,
    clearSessionId,
    clearRecordingSnapshot,
    isRecordingStorageError,
} from "../src/AudioDiary/recording_storage.js";

/** @type {Map<string, string>} */
let localStorageStore;
/** @type {Storage} */
let originalLocalStorage;

beforeEach(() => {
    originalLocalStorage = global.localStorage;
    localStorageStore = new Map();
    const mockStorage = {
        getItem: jest.fn((key) => localStorageStore.get(key) ?? null),
        setItem: jest.fn((key, value) => localStorageStore.set(key, value)),
        removeItem: jest.fn((key) => localStorageStore.delete(key)),
        clear: jest.fn(() => localStorageStore.clear()),
        get length() { return localStorageStore.size; },
        key: jest.fn((i) => Array.from(localStorageStore.keys())[i] ?? null),
    };
    Object.defineProperty(global, "localStorage", {
        value: mockStorage,
        writable: true,
        configurable: true,
    });
});

afterEach(() => {
    Object.defineProperty(global, "localStorage", {
        value: originalLocalStorage,
        writable: true,
        configurable: true,
    });
});

describe("recording_storage: isRecordingStorageError", () => {
    it("returns false for plain Error", () => {
        expect(isRecordingStorageError(new Error("test"))).toBe(false);
    });

    it("returns false for null", () => {
        expect(isRecordingStorageError(null)).toBe(false);
    });

    it("returns false for any value", () => {
        expect(isRecordingStorageError("string")).toBe(false);
        expect(isRecordingStorageError(42)).toBe(false);
        expect(isRecordingStorageError({})).toBe(false);
    });
});

describe("recording_storage: saveSessionId / loadSessionId / clearSessionId", () => {
    it("saves and loads a session ID", () => {
        saveSessionId("test-session-123");
        expect(loadSessionId()).toBe("test-session-123");
    });

    it("returns null when no session ID is stored", () => {
        expect(loadSessionId()).toBeNull();
    });

    it("clears the session ID", () => {
        saveSessionId("test-session-456");
        clearSessionId();
        expect(loadSessionId()).toBeNull();
    });

    it("overwrites an existing session ID", () => {
        saveSessionId("first-session");
        saveSessionId("second-session");
        expect(loadSessionId()).toBe("second-session");
    });
});

describe("recording_storage: clearRecordingSnapshot (deprecated compat)", () => {
    it("resolves without error and clears session ID", async () => {
        saveSessionId("some-session");
        await expect(clearRecordingSnapshot()).resolves.toBeUndefined();
        expect(loadSessionId()).toBeNull();
    });
});

describe("recording_storage: graceful degradation without localStorage", () => {
    it("saveSessionId does not throw when localStorage is unavailable", () => {
        global.localStorage.setItem.mockImplementation(() => {
            throw new Error("QuotaExceededError");
        });
        expect(() => saveSessionId("test")).not.toThrow();
    });

    it("loadSessionId returns null when localStorage throws", () => {
        global.localStorage.getItem.mockImplementation(() => {
            throw new Error("SecurityError");
        });
        expect(loadSessionId()).toBeNull();
    });

    it("clearSessionId does not throw when localStorage is unavailable", () => {
        global.localStorage.removeItem.mockImplementation(() => {
            throw new Error("SecurityError");
        });
        expect(() => clearSessionId()).not.toThrow();
    });
});

