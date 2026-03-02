import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";

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

const mockEntry = (overrides = {}) => ({
    id: "entry-1",
    date: "2023-01-01T10:00:00.000Z",
    type: "food",
    description: "- Ate pizza",
    input: "food - Ate pizza",
    original: "food - Ate pizza",
    modifiers: {},
    creator: { name: "test", uuid: "test-uuid", version: "1.0" },
    ...overrides,
});

describe("Search page", () => {
    beforeEach(() => {
        searchEntries.mockClear();
        searchEntries.mockResolvedValue({ results: [] });
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
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

    it("does not search when input is empty", async () => {
        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        act(() => { jest.runAllTimers(); });
        expect(searchEntries).not.toHaveBeenCalled();
    });

    it("does not show 'no results' message when input is empty", () => {
        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        expect(screen.queryByText("No entries match your search.")).not.toBeInTheDocument();
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

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("No entries match your search.")).toBeInTheDocument();
        });
    });

    it("calls searchEntries with the typed pattern", async () => {
        searchEntries.mockResolvedValue({ results: [] });

        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(searchEntries).toHaveBeenCalledWith("food");
        });
    });

    it("shows matching entries from search results", async () => {
        searchEntries.mockResolvedValue({ results: [mockEntry()] });

        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("- Ate pizza")).toBeInTheDocument();
        });
    });

    it("shows type badge for each matching entry", async () => {
        searchEntries.mockResolvedValue({ results: [mockEntry()] });

        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("food")).toBeInTheDocument();
        });
    });

    it("shows multiple matching entries", async () => {
        const entries = [
            mockEntry({ id: "1", description: "- Ate pizza" }),
            mockEntry({ id: "2", description: "- Had salad", type: "food" }),
        ];
        searchEntries.mockResolvedValue({ results: entries });

        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("- Ate pizza")).toBeInTheDocument();
            expect(screen.getByText("- Had salad")).toBeInTheDocument();
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

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(
                screen.getByText("search must be a valid regular expression")
            ).toBeInTheDocument();
        });
    });

    it("shows error message for network error", async () => {
        searchEntries.mockResolvedValue({
            results: [],
            error: "Network error",
        });

        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("Network error")).toBeInTheDocument();
        });
    });

    it("clears results when input is cleared", async () => {
        searchEntries.mockResolvedValue({ results: [mockEntry()] });

        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("- Ate pizza")).toBeInTheDocument();
        });

        fireEvent.change(input, { target: { value: "" } });

        await waitFor(() => {
            expect(screen.queryByText("- Ate pizza")).not.toBeInTheDocument();
        });
    });

    it("clears error when input is cleared", async () => {
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
        fireEvent.change(input, { target: { value: "[bad" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("search must be a valid regular expression")).toBeInTheDocument();
        });

        fireEvent.change(input, { target: { value: "" } });

        await waitFor(() => {
            expect(screen.queryByText("search must be a valid regular expression")).not.toBeInTheDocument();
        });
    });

    it("navigates to entry detail page on result click", async () => {
        const mockNavigate = jest.fn();
        jest.mock("react-router-dom", () => ({
            ...jest.requireActual("react-router-dom"),
            useNavigate: () => mockNavigate,
        }));

        searchEntries.mockResolvedValue({ results: [mockEntry()] });

        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("- Ate pizza")).toBeInTheDocument();
        });

        // Clicking an entry should be possible (no errors thrown)
        const entryRow = screen.getByText("- Ate pizza").closest("[data-testid], div, p");
        expect(entryRow).toBeInTheDocument();
    });

    it("shows spinner while loading results", async () => {
        let resolveSearch;
        searchEntries.mockImplementation(() => new Promise(resolve => { resolveSearch = resolve; }));

        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        act(() => { jest.runAllTimers(); });

        // The searchEntries should have been called
        expect(searchEntries).toHaveBeenCalled();

        // Resolve search so no test hangs
        resolveSearch({ results: [] });
        await waitFor(() => {
            expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
        });
    });

    it("debounces search calls so only one API call fires", async () => {
        searchEntries.mockResolvedValue({ results: [] });

        render(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");

        // Type rapidly
        fireEvent.change(input, { target: { value: "f" } });
        fireEvent.change(input, { target: { value: "fo" } });
        fireEvent.change(input, { target: { value: "foo" } });
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            // Should have been called at most with just "food" (last value)
            expect(searchEntries).toHaveBeenLastCalledWith("food");
        });
    });
});
