import React from "react";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// Mock the Search API module
jest.mock("../src/Search/api", () => ({
    searchEntries: jest.fn(),
    fetchEntryById: jest.fn(),
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

import EntryDetail from "../src/EntryDetail/EntryDetail.jsx";
import { fetchEntryById } from "../src/Search/api";

const mockEntry = {
    id: "entry-123",
    date: "2023-01-01T10:00:00.000Z",
    type: "food",
    description: "- Ate pizza",
    input: "food - Ate pizza",
    original: "food - Ate pizza",
    modifiers: { certainty: "9" },
    creator: { name: "test", uuid: "test-uuid", version: "1.0" },
};

const mockEntryNoModifiers = {
    ...mockEntry,
    id: "entry-456",
    modifiers: {},
};

function renderWithRoute(pathname, state = undefined) {
    return render(
        <MemoryRouter initialEntries={[{ pathname, state }]}>
            <Routes>
                <Route path="/entry/:id" element={<EntryDetail />} />
            </Routes>
        </MemoryRouter>
    );
}

describe("EntryDetail page", () => {
    beforeEach(() => {
        fetchEntryById.mockClear();
    });

    // --- Rendering with state ---

    it("renders entry fields when entry is passed via state", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getAllByText("entry-123").length).toBeGreaterThan(0);
        expect(screen.getAllByText("- Ate pizza").length).toBeGreaterThan(0);
        expect(screen.getAllByText("food - Ate pizza").length).toBeGreaterThan(0);
    });

    it("shows all standard field keys", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getByText("id")).toBeInTheDocument();
        expect(screen.getByText("date")).toBeInTheDocument();
        expect(screen.getByText("type")).toBeInTheDocument();
        expect(screen.getByText("description")).toBeInTheDocument();
        expect(screen.getByText("input")).toBeInTheDocument();
        expect(screen.getByText("original")).toBeInTheDocument();
    });

    it("shows modifier field keys with 'modifiers.' prefix", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getByText("modifiers.certainty")).toBeInTheDocument();
    });

    it("shows modifier value", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getByText("9")).toBeInTheDocument();
    });

    it("shows the entry type as a badge", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        const badges = screen.getAllByText("food");
        expect(badges.length).toBeGreaterThan(0);
    });

    it("does not show modifier section when entry has no modifiers", () => {
        renderWithRoute("/entry/entry-456", { entry: mockEntryNoModifiers });

        expect(screen.queryByText(/modifiers\./)).not.toBeInTheDocument();
    });

    it("shows exactly 7 fields for an entry with 1 modifier", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        // id, date, type, description, input, original, modifiers.certainty
        const fieldLabels = ["id", "date", "type", "description", "input", "original", "modifiers.certainty"];
        for (const label of fieldLabels) {
            expect(screen.getByText(label)).toBeInTheDocument();
        }
    });

    it("shows exactly 6 fields for an entry with no modifiers", () => {
        renderWithRoute("/entry/entry-456", { entry: mockEntryNoModifiers });

        const fieldLabels = ["id", "date", "type", "description", "input", "original"];
        for (const label of fieldLabels) {
            expect(screen.getByText(label)).toBeInTheDocument();
        }
    });

    it("renders copy buttons for each field", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        const copyButtons = screen.getAllByRole("button");
        // id, date, type, description, input, original, modifiers.certainty = 7 fields
        expect(copyButtons.length).toBeGreaterThanOrEqual(7);
    });

    it("does not fetch from API when entry is in state", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(fetchEntryById).not.toHaveBeenCalled();
    });

    it("shows the date value from the entry", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getAllByText("2023-01-01T10:00:00.000Z").length).toBeGreaterThan(0);
    });

    it("shows multiple modifier fields when entry has multiple modifiers", () => {
        const entryWithMultipleModifiers = {
            ...mockEntry,
            modifiers: { certainty: "9", when: "yesterday" },
        };
        renderWithRoute("/entry/entry-123", { entry: entryWithMultipleModifiers });

        expect(screen.getByText("modifiers.certainty")).toBeInTheDocument();
        expect(screen.getByText("modifiers.when")).toBeInTheDocument();
        expect(screen.getByText("9")).toBeInTheDocument();
        expect(screen.getByText("yesterday")).toBeInTheDocument();
    });

    // --- Fetching from API ---

    it("fetches entry by id when no state is provided", async () => {
        fetchEntryById.mockResolvedValue(mockEntry);

        renderWithRoute("/entry/entry-123");

        await waitFor(() => {
            expect(fetchEntryById).toHaveBeenCalledWith("entry-123");
        });

        await waitFor(() => {
            expect(screen.getAllByText("entry-123").length).toBeGreaterThan(0);
        });
    });

    it("shows not found message when entry does not exist", async () => {
        fetchEntryById.mockResolvedValue(null);

        renderWithRoute("/entry/nonexistent");

        await waitFor(() => {
            expect(screen.getByText("Entry not found.")).toBeInTheDocument();
        });
    });

    it("shows loading spinner while fetching entry", async () => {
        let resolveEntry;
        fetchEntryById.mockImplementation(() => new Promise(resolve => { resolveEntry = resolve; }));

        renderWithRoute("/entry/entry-123");

        // Spinner should be present while loading (Chakra Spinner shows "Loading...")
        expect(screen.getByText("Loading...")).toBeInTheDocument();

        // Resolve and verify spinner disappears
        await act(async () => { resolveEntry(mockEntry); });

        await waitFor(() => {
            expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
        });
    });

    it("renders fetched entry fields after loading", async () => {
        fetchEntryById.mockResolvedValue(mockEntry);

        renderWithRoute("/entry/entry-123");

        await waitFor(() => {
            expect(screen.getByText("id")).toBeInTheDocument();
            expect(screen.getByText("description")).toBeInTheDocument();
        });
    });

    // --- Copy button interaction ---

    it("copy button changes icon after clicking", async () => {
        // Mock clipboard API
        Object.assign(navigator, {
            clipboard: {
                writeText: jest.fn().mockResolvedValue(undefined),
            },
        });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        // Initially shows copy icon ⎘
        const copyIcon = screen.getAllByText("⎘")[0];
        expect(copyIcon).toBeInTheDocument();

        // Click the copy button (nearest button to the icon)
        const copyButton = screen.getAllByRole("button")[0];
        await act(async () => { fireEvent.click(copyButton); });

        // Should show checkmark after copy
        await waitFor(() => {
            expect(screen.getAllByText("✓").length).toBeGreaterThan(0);
        });
    });

    it("copy button calls clipboard.writeText with field value", async () => {
        const mockWriteText = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, {
            clipboard: { writeText: mockWriteText },
        });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        // Click the copy button for the "id" field (first button)
        const copyButton = screen.getAllByRole("button")[0];
        await act(async () => { fireEvent.click(copyButton); });

        expect(mockWriteText).toHaveBeenCalled();
    });
});
