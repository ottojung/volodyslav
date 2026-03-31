/**
 * Tests for VOLODYSLAV_HOSTNAME in environment.js and creator.js.
 */

const { make } = require("../src/environment");
const { tryDeserialize, isNestedFieldError } = require("../src/event/structure");

describe("environment.hostname()", () => {
    const original = process.env.VOLODYSLAV_HOSTNAME;

    afterEach(() => {
        if (original === undefined) {
            delete process.env.VOLODYSLAV_HOSTNAME;
        } else {
            process.env.VOLODYSLAV_HOSTNAME = original;
        }
    });

    it("returns the value of VOLODYSLAV_HOSTNAME when set", () => {
        process.env.VOLODYSLAV_HOSTNAME = "my_server-01";
        const env = make();
        expect(env.hostname()).toBe("my_server-01");
    });

    it("throws EnvironmentError when VOLODYSLAV_HOSTNAME is not set", () => {
        delete process.env.VOLODYSLAV_HOSTNAME;
        const env = make();
        expect(() => env.hostname()).toThrow("VOLODYSLAV_HOSTNAME");
    });

    it("throws EnvironmentError when VOLODYSLAV_HOSTNAME is empty", () => {
        process.env.VOLODYSLAV_HOSTNAME = "";
        const env = make();
        expect(() => env.hostname()).toThrow("[0-9a-zA-Z_-]+");
    });

    it("throws EnvironmentError when VOLODYSLAV_HOSTNAME contains unsupported characters", () => {
        process.env.VOLODYSLAV_HOSTNAME = "my-server.example.com";
        const env = make();
        expect(() => env.hostname()).toThrow("[0-9a-zA-Z_-]+");
    });

    it("is included in ensureEnvironmentIsInitialized check", () => {
        delete process.env.VOLODYSLAV_HOSTNAME;
        const env = make();
        // hostname() must throw when not set
        expect(() => env.hostname()).toThrow("VOLODYSLAV_HOSTNAME");
    });
});

describe("environment.analyzerHostname()", () => {
    const original = process.env.VOLODYSLAV_ANALYZER_HOSTNAME;

    afterEach(() => {
        if (original === undefined) {
            delete process.env.VOLODYSLAV_ANALYZER_HOSTNAME;
        } else {
            process.env.VOLODYSLAV_ANALYZER_HOSTNAME = original;
        }
    });

    it("returns the value of VOLODYSLAV_ANALYZER_HOSTNAME when set", () => {
        process.env.VOLODYSLAV_ANALYZER_HOSTNAME = "analyzer-01";
        const env = make();
        expect(env.analyzerHostname()).toBe("analyzer-01");
    });

    it("throws EnvironmentError when VOLODYSLAV_ANALYZER_HOSTNAME is not set", () => {
        delete process.env.VOLODYSLAV_ANALYZER_HOSTNAME;
        const env = make();
        expect(() => env.analyzerHostname()).toThrow("VOLODYSLAV_ANALYZER_HOSTNAME");
    });

    it("throws EnvironmentError when VOLODYSLAV_ANALYZER_HOSTNAME is empty", () => {
        process.env.VOLODYSLAV_ANALYZER_HOSTNAME = "";
        const env = make();
        expect(() => env.analyzerHostname()).toThrow("[0-9a-zA-Z_-]+");
    });

    it("throws EnvironmentError when VOLODYSLAV_ANALYZER_HOSTNAME contains unsupported characters", () => {
        process.env.VOLODYSLAV_ANALYZER_HOSTNAME = "my-analyzer.example.com";
        const env = make();
        expect(() => env.analyzerHostname()).toThrow("[0-9a-zA-Z_-]+");
    });

    it("is independent from VOLODYSLAV_HOSTNAME", () => {
        process.env.VOLODYSLAV_ANALYZER_HOSTNAME = "analyzer-host";
        process.env.VOLODYSLAV_HOSTNAME = "worker-host";
        const env = make();
        expect(env.analyzerHostname()).toBe("analyzer-host");
        expect(env.hostname()).toBe("worker-host");
    });
});

describe("creator hostname in event tryDeserialize()", () => {
    const baseEvent = {
        id: "abc",
        date: "2025-01-01T00:00:00.000Z",
        original: "o",
        input: "i",
    };

    it("returns error when creator.hostname is missing", () => {
        const obj = {
            ...baseEvent,
            creator: { name: "n", uuid: "u", version: "v" },
        };
        const result = tryDeserialize(obj);
        expect(isNestedFieldError(result)).toBe(true);
        expect(result.parentField).toBe("creator");
        expect(result.nestedField).toBe("hostname");
    });

    it("returns error when creator.hostname is not a string", () => {
        const obj = {
            ...baseEvent,
            creator: { name: "n", uuid: "u", version: "v", hostname: 123 },
        };
        const result = tryDeserialize(obj);
        expect(isNestedFieldError(result)).toBe(true);
        expect(result.parentField).toBe("creator");
        expect(result.nestedField).toBe("hostname");
    });

    it("successfully deserializes event with all creator fields including hostname", () => {
        const obj = {
            ...baseEvent,
            creator: { name: "Volodyslav", uuid: "some-uuid", version: "1.0.0", hostname: "my-host" },
        };
        const result = tryDeserialize(obj);
        expect(isNestedFieldError(result)).toBe(false);
        expect(result.creator.hostname).toBe("my-host");
        expect(result.creator.name).toBe("Volodyslav");
        expect(result.creator.uuid).toBe("some-uuid");
        expect(result.creator.version).toBe("1.0.0");
    });

    it("preserves the hostname value exactly as given", () => {
        const obj = {
            ...baseEvent,
            creator: { name: "n", uuid: "u", version: "v", hostname: "server-01.prod.example.com" },
        };
        const result = tryDeserialize(obj);
        expect(isNestedFieldError(result)).toBe(false);
        expect(result.creator.hostname).toBe("server-01.prod.example.com");
    });
});
