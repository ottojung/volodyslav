import React from "react";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { ChakraProvider } from "@chakra-ui/react";

jest.mock("../src/Sync/api.js", () => ({
    postSync: jest.fn(),
    fetchSyncHostnames: jest.fn(),
}));

jest.mock("../src/version_api.js", () => ({
    fetchVersion: jest.fn(),
}));

jest.mock("../src/DescriptionEntry/logger.js", () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

import App from "../src/App.jsx";
import { postSync, fetchSyncHostnames } from "../src/Sync/api.js";
import { fetchVersion } from "../src/version_api.js";

function renderApp() {
    return render(
        <ChakraProvider>
            <MemoryRouter>
                <App />
            </MemoryRouter>
        </ChakraProvider>
    );
}

describe("App", () => {
    beforeEach(() => {
        fetchVersion.mockReset();
        postSync.mockReset();
        fetchSyncHostnames.mockReset();
        fetchSyncHostnames.mockResolvedValue(["test-host", "alice"]);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("shows the fetched version in the footer", async () => {
        fetchVersion.mockResolvedValue("1.2.3");

        renderApp();

        await waitFor(() => {
            expect(screen.getByText("Volodyslav 1.2.3")).toBeInTheDocument();
        });
    });

    it("shows a fallback when the version cannot be loaded", async () => {
        fetchVersion.mockResolvedValue(null);

        renderApp();

        await waitFor(() => {
            expect(
                screen.getByText("Volodyslav version unavailable")
            ).toBeInTheDocument();
        });
    });

    it("shows detailed sync errors", async () => {
        fetchVersion.mockResolvedValue("1.2.3");
        postSync.mockResolvedValue({
            success: false,
            error: "Sync failed: Generators database sync failed: git push failed",
            details: [
                {
                    name: "GeneratorsSyncError",
                    message: "Generators database sync failed: git push failed",
                    causes: ["git push failed"],
                },
            ],
        });

        renderApp();

        fireEvent.click(screen.getByText("Sync"));

        await waitFor(() => {
            expect(screen.getByText("Sync failed")).toBeInTheDocument();
        });

        expect(
            screen.getByText("Sync failed: Generators database sync failed: git push failed")
        ).toBeInTheDocument();
        expect(screen.getByText("GeneratorsSyncError")).toBeInTheDocument();
        expect(screen.getByText("Generators database sync failed: git push failed")).toBeInTheDocument();
        expect(screen.getByText("git push failed")).toBeInTheDocument();
    });

    it("shows a persistent success confirmation after sync completes", async () => {
        jest.useFakeTimers();
        fetchVersion.mockResolvedValue("1.2.3");
        postSync.mockResolvedValue({ success: true });

        renderApp();

        fireEvent.click(screen.getByText("Sync"));

        await waitFor(() => {
            expect(screen.getByText("Sync complete")).toBeInTheDocument();
        });

        expect(screen.getByText("Your local and remote data are now in sync.")).toBeInTheDocument();
        expect(screen.getByText("Synced!")).toBeInTheDocument();

        act(() => {
            jest.advanceTimersByTime(2000);
        });

        await waitFor(() => {
            expect(screen.getByText("Sync")).toBeInTheDocument();
        });

        expect(screen.getByText("Sync complete")).toBeInTheDocument();
    });

    it("clears a previous success confirmation when the sync mode changes", async () => {
        fetchVersion.mockResolvedValue("1.2.3");
        postSync.mockResolvedValue({ success: true });

        renderApp();

        fireEvent.click(screen.getByText("Sync"));

        await waitFor(() => {
            expect(screen.getByText("Sync complete")).toBeInTheDocument();
        });

        fireEvent.change(screen.getByLabelText("Sync mode"), {
            target: { value: "reset-to-hostname" },
        });

        await waitFor(() => {
            expect(screen.queryByText("Sync complete")).not.toBeInTheDocument();
        });
    });

    it("shows individual step results after a successful sync", async () => {
        fetchVersion.mockResolvedValue("1.2.3");
        postSync.mockResolvedValue({
            success: true,
            steps: [
                { name: "generators", status: "success" },
                { name: "assets", status: "success" },
            ],
        });

        renderApp();

        fireEvent.click(screen.getByText("Sync"));

        await waitFor(() => {
            expect(screen.getByText("Sync complete")).toBeInTheDocument();
        });

        expect(screen.getByText("Generators")).toBeInTheDocument();
        expect(screen.getByText("Assets")).toBeInTheDocument();
        expect(screen.getAllByText("done")).toHaveLength(2);
    });

    it("shows individual step results when some steps fail", async () => {
        fetchVersion.mockResolvedValue("1.2.3");
        postSync.mockResolvedValue({
            success: false,
            error: "Sync failed: Generators database sync failed",
            details: [
                {
                    name: "GeneratorsSyncError",
                    message: "Generators database sync failed",
                    causes: ["db error"],
                },
            ],
            steps: [
                { name: "generators", status: "error" },
            ],
        });

        renderApp();

        fireEvent.click(screen.getByText("Sync"));

        await waitFor(() => {
            expect(screen.getByText("Sync failed")).toBeInTheDocument();
        });

        expect(screen.getByText("Generators")).toBeInTheDocument();
        expect(screen.getByText("failed")).toBeInTheDocument();
    });

    it("shows step progress via the onProgress callback during sync", async () => {
        fetchVersion.mockResolvedValue("1.2.3");

        postSync.mockImplementation((_resetToHostname, onProgress) => {
            onProgress?.([{ name: "generators", status: "success" }]);
            return Promise.resolve({ success: true, steps: [{ name: "generators", status: "success" }] });
        });

        renderApp();

        fireEvent.click(screen.getByText("Sync"));

        await waitFor(() => {
            expect(screen.getByText("Generators")).toBeInTheDocument();
        });
    });

    it("clears step list when sync mode changes", async () => {
        fetchVersion.mockResolvedValue("1.2.3");
        postSync.mockResolvedValue({
            success: true,
            steps: [
                { name: "generators", status: "success" },
                { name: "assets", status: "success" },
            ],
        });

        renderApp();

        fireEvent.click(screen.getByText("Sync"));

        await waitFor(() => {
            expect(screen.getByText("Generators")).toBeInTheDocument();
        });

        fireEvent.change(screen.getByLabelText("Sync mode"), {
            target: { value: "reset-to-hostname" },
        });

        await waitFor(() => {
            expect(screen.queryByText("Generators")).not.toBeInTheDocument();
        });
    });

    it("sends a custom reset hostname and shows it in the success message", async () => {
        fetchVersion.mockResolvedValue("1.2.3");
        postSync.mockResolvedValue({ success: true });

        renderApp();

        fireEvent.change(screen.getByLabelText("Sync mode"), {
            target: { value: "reset-to-hostname" },
        });
        await waitFor(() => {
            expect(screen.getByRole("option", { name: "alice" })).toBeInTheDocument();
        });
        fireEvent.change(screen.getByLabelText("Reset hostname"), { target: { value: "alice" } });
        fireEvent.click(screen.getByText("Sync"));

        await waitFor(() => {
            expect(postSync).toHaveBeenCalledWith("alice", expect.any(Function));
        });
        expect(
            screen.getByText("Your local data was reset to match alice-main.")
        ).toBeInTheDocument();
    });

    it("shows reset hostname dropdown only in reset mode", async () => {
        fetchVersion.mockResolvedValue("1.2.3");
        postSync.mockResolvedValue({ success: true });

        renderApp();

        expect(screen.queryByLabelText("Reset hostname")).not.toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Sync mode"), {
            target: { value: "reset-to-hostname" },
        });

        await waitFor(() => {
            expect(screen.getByLabelText("Reset hostname")).toBeInTheDocument();
        });
    });
});
