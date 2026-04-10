jest.mock("../src/capabilities", () => ({
    make: jest.fn(),
}));

jest.mock("commander", () => {
    class FakeCommand {
        name() {
            return this;
        }

        description() {
            return this;
        }

        option() {
            return this;
        }

        argument() {
            return this;
        }

        action() {
            return this;
        }

        command() {
            return this;
        }

        async parseAsync() {
            throw new Error("unexpected failure from CLI parser");
        }
    }

    return {
        Command: FakeCommand,
    };
});

const root = require("../src/capabilities");
const { entry } = require("../src/index");

describe("entry fatal error handling", () => {
    test("entry logs and exits on non-user fatal errors", async () => {
        const capabilities = {
            logger: {
                logError: jest.fn(),
                printf: jest.fn(),
            },
            exiter: {
                exit: jest.fn(),
            },
        };

        root.make.mockReturnValue(capabilities);

        await expect(entry()).resolves.toBeUndefined();

        expect(capabilities.logger.logError).toHaveBeenCalledWith(
            expect.objectContaining({
                errorName: "Error",
                errorMessage: "unexpected failure from CLI parser",
            }),
            "Fatal unhandled error"
        );
        expect(capabilities.exiter.exit).toHaveBeenCalledWith(1);
    });
});
