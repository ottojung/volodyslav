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
                if (String(filePath).endsWith("VERSION")) {
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
});
