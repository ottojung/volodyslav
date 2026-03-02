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

import Search from "../src/Search/Search.jsx";
import { searchEntries } from "../src/Search/api";

describe("Search page", () => {
    beforeEach(() => {
        searchEntries.mockClear();
        searchEntries.mockResolvedValue({ results: [] });
    });

    it("renders the search input", () => {
        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        expect(
            screen.getByPlaceholderText("Search entries by regex...")
        ).toBeInTheDocument();
    });

    it("shows no results message when search returns nothing", async () => {
        searchEntries.mockResolvedValue({ results: [] });

        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await waitFor(() => {
            expect(screen.getByText("No entries match your search.")).toBeInTheDocument();
        });
    });

    it("shows matching entries from search results", async () => {
        const mockEntries = [
            {
                id: "1",
                date: "2023-01-01T10:00:00.000Z",
                type: "food",
                description: "- Ate pizza",
                input: "food - Ate pizza",
                original: "food - Ate pizza",
                modifiers: {},
                creator: { name: "test", uuid: "test-uuid", version: "1.0" },
            },
        ];
        searchEntries.mockResolvedValue({ results: mockEntries });

        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await waitFor(() => {
            expect(screen.getByText("- Ate pizza")).toBeInTheDocument();
        });
    });

    it("shows error message for invalid regex", async () => {
        searchEntries.mockResolvedValue({
            results: [],
            error: "search must be a valid regular expression",
        });

        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "[invalid" } });

        await waitFor(() => {
            expect(
                screen.getByText("search must be a valid regular expression")
            ).toBeInTheDocument();
        });
    });

    it("does not search when input is empty", async () => {
        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        // No search should happen with empty input
        await waitFor(() => {
            expect(searchEntries).not.toHaveBeenCalled();
        });
    });
});
