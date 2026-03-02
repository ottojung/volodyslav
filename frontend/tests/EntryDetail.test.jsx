import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

describe("EntryDetail page", () => {
    beforeEach(() => {
        fetchEntryById.mockClear();
    });

    it("renders entry fields when entry is passed via state", () => {
        render(
            <MemoryRouter initialEntries={[{ pathname: "/entry/entry-123", state: { entry: mockEntry } }]}>
                <Routes>
                    <Route path="/entry/:id" element={<EntryDetail />} />
                </Routes>
            </MemoryRouter>
        );

        expect(screen.getAllByText("entry-123").length).toBeGreaterThan(0);
        expect(screen.getAllByText("- Ate pizza").length).toBeGreaterThan(0);
        expect(screen.getAllByText("food - Ate pizza").length).toBeGreaterThan(0);
    });

    it("shows all field keys", () => {
        render(
            <MemoryRouter initialEntries={[{ pathname: "/entry/entry-123", state: { entry: mockEntry } }]}>
                <Routes>
                    <Route path="/entry/:id" element={<EntryDetail />} />
                </Routes>
            </MemoryRouter>
        );

        expect(screen.getByText("id")).toBeInTheDocument();
        expect(screen.getByText("date")).toBeInTheDocument();
        expect(screen.getByText("type")).toBeInTheDocument();
        expect(screen.getByText("description")).toBeInTheDocument();
        expect(screen.getByText("input")).toBeInTheDocument();
        expect(screen.getByText("original")).toBeInTheDocument();
        expect(screen.getByText("modifiers.certainty")).toBeInTheDocument();
    });

    it("fetches entry by id when no state is provided", async () => {
        fetchEntryById.mockResolvedValue(mockEntry);

        render(
            <MemoryRouter initialEntries={["/entry/entry-123"]}>
                <Routes>
                    <Route path="/entry/:id" element={<EntryDetail />} />
                </Routes>
            </MemoryRouter>
        );

        await waitFor(() => {
            expect(fetchEntryById).toHaveBeenCalledWith("entry-123");
        });

        await waitFor(() => {
            expect(screen.getAllByText("entry-123").length).toBeGreaterThan(0);
        });
    });

    it("shows not found message when entry does not exist", async () => {
        fetchEntryById.mockResolvedValue(null);

        render(
            <MemoryRouter initialEntries={["/entry/nonexistent"]}>
                <Routes>
                    <Route path="/entry/:id" element={<EntryDetail />} />
                </Routes>
            </MemoryRouter>
        );

        await waitFor(() => {
            expect(screen.getByText("Entry not found.")).toBeInTheDocument();
        });
    });

    it("renders copy buttons for each field", () => {
        render(
            <MemoryRouter initialEntries={[{ pathname: "/entry/entry-123", state: { entry: mockEntry } }]}>
                <Routes>
                    <Route path="/entry/:id" element={<EntryDetail />} />
                </Routes>
            </MemoryRouter>
        );

        const copyButtons = screen.getAllByRole("button");
        // Each field (id, date, type, description, input, original, modifiers.certainty = 7 fields) has a copy button
        expect(copyButtons.length).toBeGreaterThanOrEqual(7);
    });
});
