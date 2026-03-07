const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

async function makeApp(capabilities) {
    const app = expressApp.make();
    capabilities.logger.enableHttpCallsLogging(app);
    await addRoutes(capabilities, app);
    return app;
}

describe("GET /api/version", () => {
    it("returns the current version", async () => {
        const capabilities = getTestCapabilities();
        capabilities.git.call = jest.fn();
        capabilities.checker.instantiate = jest
            .fn()
            .mockImplementation(async (filePath) => {
                if (typeof filePath === "string" && filePath.endsWith("VERSION")) {
                    return { path: "/tmp/VERSION" };
                }

                throw new Error("file not found");
            });
        capabilities.reader.readFileAsText = jest
            .fn()
            .mockImplementation(async (filePath) => {
                if (filePath === "/tmp/VERSION") {
                    return "1.2.3\n";
                }

                throw new Error("unexpected read");
            });

        const app = await makeApp(capabilities);
        const res = await request(app).get("/api/version");

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ version: "1.2.3" });
        expect(capabilities.reader.readFileAsText).toHaveBeenCalledWith(
            "/tmp/VERSION"
        );
        expect(capabilities.git.call).not.toHaveBeenCalled();
    });

    it("falls back to package.json when VERSION and git describe are unavailable", async () => {
        const capabilities = getTestCapabilities();
        capabilities.git.ensureAvailable = jest.fn();
        capabilities.git.call = jest
            .fn()
            .mockRejectedValue(new Error("git describe failed"));
        capabilities.checker.instantiate = jest
            .fn()
            .mockImplementation(async (filePath) => {
                if (
                    typeof filePath === "string" &&
                    filePath.endsWith("package.json")
                ) {
                    return { path: "/tmp/package.json" };
                }

                throw new Error("file not found");
            });
        capabilities.reader.readFileAsText = jest
            .fn()
            .mockImplementation(async (filePath) => {
                if (filePath === "/tmp/package.json") {
                    return JSON.stringify({ version: "0.1.0" });
                }

                throw new Error("unexpected read");
            });

        const app = await makeApp(capabilities);
        const res = await request(app).get("/api/version");

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ version: "0.1.0" });
        expect(capabilities.git.call).toHaveBeenCalled();
    });
});
