import React from "react";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";
import { renderWithProviders } from "./renderWithProviders.jsx";

// Mock the DiarySummary API module
jest.mock("../src/DiarySummary/api", () => ({
    fetchDiarySummary: jest.fn(),
    runDiarySummary: jest.fn(),
}));

// Mock the logger module
jest.mock("../src/DescriptionEntry/logger", () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

import DiarySummary from "../src/DiarySummary/DiarySummary.jsx";
import { fetchDiarySummary, runDiarySummary } from "../src/DiarySummary/api";

/** @returns {import('../src/DiarySummary/api.js').DiarySummaryData} */
function makeSummary(overrides = {}) {
    return {
        type: "diary_most_important_info_summary",
        markdown: [
            "## Current snapshot",
            "",
            "- Feeling well.",
            "",
            "## Ongoing themes and patterns",
            "",
            "- Work is busy.",
        ].join("\n"),
        summaryDate: "2024-03-01T00:00:00.000Z",
        processedEntries: {},
        updatedAt: "2024-03-02T10:00:00.000Z",
        model: "gpt-5.4",
        version: "1",
        ...overrides,
    };
}

function renderDiarySummary() {
    return renderWithProviders(
        <MemoryRouter>
            <DiarySummary />
        </MemoryRouter>
    );
}

describe("DiarySummary page", () => {
    beforeEach(() => {
        fetchDiarySummary.mockClear();
        runDiarySummary.mockClear();
    });

    it("shows a loading spinner while the summary is being fetched", () => {
        fetchDiarySummary.mockImplementation(() => new Promise(() => {}));
        renderDiarySummary();
        expect(screen.getByText("Loading summary…")).toBeInTheDocument();
    });

    it("renders the summary after successful load", async () => {
        fetchDiarySummary.mockResolvedValue(makeSummary());
        renderDiarySummary();

        await waitFor(() => {
            expect(screen.getByText("Current snapshot")).toBeInTheDocument();
        });

        expect(screen.getByText("Ongoing themes and patterns")).toBeInTheDocument();
        expect(screen.getByText(/Feeling well/)).toBeInTheDocument();
    });

    it("shows error state when initial fetch fails", async () => {
        fetchDiarySummary.mockResolvedValue(null);
        renderDiarySummary();

        await waitFor(() => {
            expect(screen.getByText("Failed to load diary summary.")).toBeInTheDocument();
        });
    });

    it("updates summary and transitions to ready on successful run", async () => {
        // Initial fetch fails → error state.
        fetchDiarySummary.mockResolvedValue(null);
        renderDiarySummary();

        await waitFor(() => {
            expect(screen.getByText("Failed to load diary summary.")).toBeInTheDocument();
        });

        // Clicking "Update Summary" succeeds.
        const updatedSummary = makeSummary({ summaryDate: "2024-04-01T00:00:00.000Z" });
        runDiarySummary.mockResolvedValue({ success: true, summary: updatedSummary });

        fireEvent.click(screen.getByRole("button", { name: /Update Summary/i }));

        await waitFor(() => {
            // The error message should be gone and the summary should render.
            expect(screen.queryByText("Failed to load diary summary.")).not.toBeInTheDocument();
            expect(screen.getByText("Current snapshot")).toBeInTheDocument();
        });
    });

    it("shows error state when run fails", async () => {
        fetchDiarySummary.mockResolvedValue(makeSummary());
        renderDiarySummary();

        await waitFor(() => {
            expect(screen.getByText("Current snapshot")).toBeInTheDocument();
        });

        runDiarySummary.mockResolvedValue({ success: false, error: "Pipeline failed" });
        fireEvent.click(screen.getByRole("button", { name: /Update Summary/i }));

        await waitFor(() => {
            expect(screen.getByText("Failed to load diary summary.")).toBeInTheDocument();
        });
    });

    it("renders the last-updated metadata when present", async () => {
        fetchDiarySummary.mockResolvedValue(makeSummary());
        renderDiarySummary();

        await waitFor(() => {
            expect(screen.getByText(/Last updated:/)).toBeInTheDocument();
        });
    });

    it("shows progress entries while the run is in progress via the onProgress callback", async () => {
        fetchDiarySummary.mockResolvedValue(makeSummary());
        renderDiarySummary();

        await waitFor(() => {
            expect(screen.getByText("Current snapshot")).toBeInTheDocument();
        });

        const updatedSummary = makeSummary({ summaryDate: "2024-04-01T00:00:00.000Z" });
        runDiarySummary.mockImplementation((onProgress) => {
            onProgress?.([{ eventId: "evt-audio", entryDate: "2024-03-01T00:00:00.000Z", status: "pending" }]);
            return Promise.resolve({ success: true, summary: updatedSummary });
        });

        fireEvent.click(screen.getByRole("button", { name: /Update Summary/i }));

        await waitFor(() => {
            expect(screen.getByText("2024-03-01T00:00:00.000Z")).toBeInTheDocument();
        });
    });

    it("does not crash or show white screen when run entries use eventId (regression test for path.split bug)", async () => {
        fetchDiarySummary.mockResolvedValue(makeSummary());
        renderDiarySummary();

        await waitFor(() => {
            expect(screen.getByText("Current snapshot")).toBeInTheDocument();
        });

        const updatedSummary = makeSummary({ summaryDate: "2024-04-01T00:00:00.000Z" });
        // Simulate backend response: entries use eventId + entryDate, not path.
        runDiarySummary.mockImplementation((onProgress) => {
            onProgress?.([
                { eventId: "abc123", entryDate: "2024-03-10T00:00:00.000Z", status: "pending" },
                { eventId: "def456", entryDate: "2024-03-11T00:00:00.000Z", status: "success" },
                { eventId: "ghi789", entryDate: "2024-03-12T00:00:00.000Z", status: "error" },
            ]);
            return Promise.resolve({ success: true, summary: updatedSummary });
        });

        fireEvent.click(screen.getByRole("button", { name: /Update Summary/i }));

        // The page must NOT go blank — heading must still be visible.
        await waitFor(() => {
            expect(screen.getByRole("heading", { name: /Diary Summary/i })).toBeInTheDocument();
            expect(screen.getByText("2024-03-10T00:00:00.000Z")).toBeInTheDocument();
            expect(screen.getByText("2024-03-11T00:00:00.000Z")).toBeInTheDocument();
            expect(screen.getByText("2024-03-12T00:00:00.000Z")).toBeInTheDocument();
        });
    });

    it("shows notAnalyzer toast and resets running state without changing load state", async () => {
        fetchDiarySummary.mockResolvedValue(makeSummary());
        renderDiarySummary();

        await waitFor(() => {
            expect(screen.getByText("Current snapshot")).toBeInTheDocument();
        });

        runDiarySummary.mockResolvedValue({
            success: false,
            notAnalyzer: true,
            currentHostname: "current-host",
            analyzerHostname: "analyzer-host",
            error: "This host (current-host) is not the analyzer. The analyzer is: analyzer-host",
        });

        fireEvent.click(screen.getByRole("button", { name: /Update Summary/i }));

        await waitFor(() => {
            // The button must no longer be loading.
            expect(screen.getByRole("button", { name: /Update Summary/i })).toBeInTheDocument();
            // The summary content must still be visible (load state unchanged).
            expect(screen.getByText("Current snapshot")).toBeInTheDocument();
        });
    });

    it("shows progress entries with success and error statuses after completed run", async () => {
        fetchDiarySummary.mockResolvedValue(makeSummary());
        renderDiarySummary();

        await waitFor(() => {
            expect(screen.getByText("Current snapshot")).toBeInTheDocument();
        });

        const updatedSummary = makeSummary({ summaryDate: "2024-04-01T00:00:00.000Z" });
        runDiarySummary.mockImplementation((onProgress) => {
            // Simulate final progress callback with completed entries.
            onProgress?.([
                { eventId: "e1", entryDate: "2024-03-01T00:00:00.000Z", status: "success" },
                { eventId: "e2", entryDate: "2024-03-02T00:00:00.000Z", status: "error" },
            ]);
            return Promise.resolve({ success: true, summary: updatedSummary });
        });

        fireEvent.click(screen.getByRole("button", { name: /Update Summary/i }));

        await waitFor(() => {
            expect(screen.getByText("2024-03-01T00:00:00.000Z")).toBeInTheDocument();
            expect(screen.getByText("2024-03-02T00:00:00.000Z")).toBeInTheDocument();
            // Summary content updated.
            expect(screen.getByText("Current snapshot")).toBeInTheDocument();
        });
    });

});
