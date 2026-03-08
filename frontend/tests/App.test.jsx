import React from "react";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { ChakraProvider } from "@chakra-ui/react";

jest.mock("../src/Sync/api.js", () => ({
    postSync: jest.fn(),
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
import { postSync } from "../src/Sync/api.js";
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
            error: "Sync failed: Event log sync failed: git push failed",
            details: [
                {
                    name: "EventLogSyncError",
                    message: "Event log sync failed: git push failed",
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
            screen.getByText("Sync failed: Event log sync failed: git push failed")
        ).toBeInTheDocument();
        expect(screen.getByText("EventLogSyncError")).toBeInTheDocument();
        expect(screen.getByText("Event log sync failed: git push failed")).toBeInTheDocument();
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

        fireEvent.change(screen.getByRole("combobox"), {
            target: { value: "reset-to-theirs" },
        });

        await waitFor(() => {
            expect(screen.queryByText("Sync complete")).not.toBeInTheDocument();
        });
    });
});
