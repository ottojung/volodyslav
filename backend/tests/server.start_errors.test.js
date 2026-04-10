jest.mock("../src/express_app", () => ({
    make: jest.fn(() => ({ mocked: true })),
    run: jest.fn(async () => {
        throw new Error("startup exploded");
    }),
}));

const server = require("../src/server");

function makeCapabilities() {
    return {
        logger: {
            setup: jest.fn(async () => undefined),
            logInfo: jest.fn(),
            logError: jest.fn(),
        },
        exiter: {
            exit: jest.fn(),
        },
    };
}

describe("server start fatal error logging", () => {
    test("start logs and exits on startup failures", async () => {
        const capabilities = makeCapabilities();

        await expect(server.start(capabilities)()).resolves.toBeUndefined();

        expect(capabilities.logger.logError).toHaveBeenCalledWith(
            expect.objectContaining({
                errorName: "Error",
                errorMessage: "startup exploded",
            }),
            "Server startup failed"
        );
        expect(capabilities.exiter.exit).toHaveBeenCalledWith(1);
    });
});
