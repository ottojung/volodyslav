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
        processedTranscriptions: {},
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
        runDiarySummary.mockResolvedValue(updatedSummary);

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

        runDiarySummary.mockResolvedValue(null);
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
});
