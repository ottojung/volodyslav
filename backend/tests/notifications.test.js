jest.mock("../src/subprocess/call", () => ({
    // just start with an empty mock, no default implementation
    callSubprocess: jest.fn(),
}));

let notifyAboutError,
    notifyAboutWarning,
    ensureNotificationsAvailable,
    callSubprocess;

beforeEach(() => {
    jest.resetModules(); // clear the require cache (and your IIFE memo)
    jest.clearAllMocks(); // clear any mock history

    // now re-require everything
    const notifications = require("../src/notifications");
    notifyAboutError = notifications.notifyAboutError;
    notifyAboutWarning = notifications.notifyAboutWarning;
    ensureNotificationsAvailable = notifications.ensureNotificationsAvailable;

    // grab the mock from subprocess
    ({ callSubprocess } = require("../src/subprocess/call"));
});

describe("notifications", () => {
    describe("ensureNotificationsAvailable", () => {
        it("resolves if termux-notification is on PATH", async () => {
            callSubprocess.mockResolvedValueOnce({
                stdout: "/usr/bin/termux-notification\n",
            });
            await expect(ensureNotificationsAvailable()).resolves.not.toThrow();
        });

        it("throws if termux-notification is missing", async () => {
            callSubprocess.mockRejectedValueOnce(new Error("not found"));
            await expect(ensureNotificationsAvailable()).rejects.toThrow(
                "Notifications unavailable. Termux notification executable not found in $PATH."
            );
        });

        it("throws if command call fails for other reasons", async () => {
            callSubprocess.mockRejectedValueOnce(new Error("permission denied"));
            await expect(ensureNotificationsAvailable()).rejects.toThrow();
        });
    });

    describe("notifyAboutError", () => {
        it("invokes termux-notification with Error", async () => {
            callSubprocess.mockResolvedValueOnce({
                stdout: "/usr/bin/termux-notification\n",
            });
            await notifyAboutError("foo");
            expect(callSubprocess).toHaveBeenCalledWith(
                "/usr/bin/termux-notification",
                ["-t", "Error", "-c", "foo"],
                {}
            );
        });

        it("handles empty error message", async () => {
            callSubprocess.mockResolvedValueOnce({
                stdout: "/usr/bin/termux-notification\n",
            });
            await notifyAboutError("");
            expect(callSubprocess).toHaveBeenCalledWith(
                "/usr/bin/termux-notification",
                ["-t", "Error", "-c", ""],
                {}
            );
        });

        it("handles error objects", async () => {
            callSubprocess.mockResolvedValueOnce({
                stdout: "/usr/bin/termux-notification\n",
            });
            const message = "test error";
            await notifyAboutError(message);
            expect(callSubprocess).toHaveBeenCalledWith(
                "/usr/bin/termux-notification",
                ["-t", "Error", "-c", message],
                {}
            );
        });
    });

    describe("notifyAboutWarning", () => {
        it("invokes termux-notification with Warning", async () => {
            callSubprocess.mockResolvedValueOnce({
                stdout: "/usr/bin/termux-notification\n",
            });
            await notifyAboutWarning("bar");
            expect(callSubprocess).toHaveBeenCalledWith(
                "/usr/bin/termux-notification",
                ["-t", "Warning", "-c", "bar"],
                {}
            );
        });

        it("handles empty warning message", async () => {
            callSubprocess.mockResolvedValueOnce({
                stdout: "/usr/bin/termux-notification\n",
            });
            await notifyAboutWarning("");
            expect(callSubprocess).toHaveBeenCalledWith(
                "/usr/bin/termux-notification",
                ["-t", "Warning", "-c", ""],
                {}
            );
        });

        it("handles warning objects", async () => {
            callSubprocess.mockResolvedValueOnce({
                stdout: "/usr/bin/termux-notification\n",
            });
            const message = "test warning";
            await notifyAboutWarning(message);
            expect(callSubprocess).toHaveBeenCalledWith(
                "/usr/bin/termux-notification",
                ["-t", "Warning", "-c", message],
                {}
            );
        });
    });
});
