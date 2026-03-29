import React from "react";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, useNavigationType } from "react-router-dom";
import { renderWithProviders } from "./renderWithProviders.jsx";

jest.mock("react-router-dom", () => {
    const actual = jest.requireActual("react-router-dom");
    return {
        ...actual,
        useNavigationType: jest.fn(() => "POP"),
    };
});

// Mock the Search API module
jest.mock("../src/Search/api", () => ({
    searchEntries: jest.fn(),
    fetchEntryById: jest.fn(),
    fetchAdditionalProperties: jest.fn(),
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
import { searchEntries, fetchAdditionalProperties } from "../src/Search/api";

const mockEntry = (overrides = {}) => ({
    id: "entry-1",
    date: "2023-01-01T10:00:00.000Z",
    input: "food - Ate pizza",
    original: "food - Ate pizza",
    creator: { name: "test", uuid: "test-uuid", version: "1.0" },
    ...overrides,
});

describe("Search page", () => {
    beforeEach(() => {
        searchEntries.mockClear();
        fetchAdditionalProperties.mockClear();
        searchEntries.mockResolvedValue({ results: [] });
        fetchAdditionalProperties.mockResolvedValue({});
        jest.useFakeTimers();
        sessionStorage.clear();
        useNavigationType.mockReturnValue("POP");
    });

    afterEach(() => {
        jest.useRealTimers();
        sessionStorage.clear();
    });

    it("renders the search input", () => {
        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        expect(
            screen.getByPlaceholderText("Search entries by regex...")
        ).toBeInTheDocument();
    });

    it("shows recent entries on initial load", async () => {
        searchEntries.mockResolvedValue({ results: [mockEntry({ input: "food - Recent entry" })] });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("- Recent entry")).toBeInTheDocument();
        });

        expect(searchEntries).toHaveBeenCalledWith("", 1);
    });

    it("searches with empty pattern to fetch all entries when input is empty", async () => {
        searchEntries.mockResolvedValue({ results: [] });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        await act(async () => { jest.runAllTimers(); });
        expect(searchEntries).toHaveBeenCalledWith("", 1);
    });

    it("does not show 'no results' message when input is empty", () => {
        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        expect(screen.queryByText("No entries match your search.")).not.toBeInTheDocument();
    });

    it("shows no results message when search returns nothing", async () => {
        searchEntries.mockResolvedValue({ results: [] });

        renderWithProviders(
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
        searchEntries.mockResolvedValue({ results: [], hasMore: false });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(searchEntries).toHaveBeenCalledWith("food", 1);
        });
    });

    it("shows matching entries from search results", async () => {
        searchEntries.mockResolvedValue({ results: [mockEntry()] });

        renderWithProviders(
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

        renderWithProviders(
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
            mockEntry({ id: "1", input: "food - Ate pizza" }),
            mockEntry({ id: "2", input: "food - Had salad" }),
        ];
        searchEntries.mockResolvedValue({ results: entries });

        renderWithProviders(
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

        renderWithProviders(
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

        renderWithProviders(
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

    it("shows recent entries when input is cleared", async () => {
        searchEntries
            .mockResolvedValueOnce({ results: [] })
            .mockResolvedValueOnce({ results: [mockEntry()] })
            .mockResolvedValueOnce({ results: [] });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");

        // Wait for initial recent-entries load
        await act(async () => { jest.runAllTimers(); });

        fireEvent.change(input, { target: { value: "food" } });
        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("- Ate pizza")).toBeInTheDocument();
        });

        fireEvent.change(input, { target: { value: "" } });
        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(searchEntries).toHaveBeenLastCalledWith("", 1);
        });
    });

    it("clears error when input is cleared", async () => {
        searchEntries.mockResolvedValue({
            results: [],
            error: "search must be a valid regular expression",
        });

        renderWithProviders(
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

        renderWithProviders(
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

        renderWithProviders(
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
        resolveSearch({ results: [], hasMore: false });
        await waitFor(() => {
            expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
        });
    });

    it("debounces search calls so only one API call fires", async () => {
        searchEntries.mockResolvedValue({ results: [], hasMore: false });

        renderWithProviders(
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
            expect(searchEntries).toHaveBeenLastCalledWith("food", 1);
        });
    });

    it("shows 'Load more' button when hasMore is true", async () => {
        searchEntries.mockResolvedValue({ results: [mockEntry()], hasMore: true });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("Load more")).toBeInTheDocument();
        });
    });

    it("does not show 'Load more' button when hasMore is false", async () => {
        searchEntries.mockResolvedValue({ results: [mockEntry()], hasMore: false });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.queryByText("Load more")).not.toBeInTheDocument();
        });
    });

    it("shows 'All matching entries are displayed' when hasMore is false and results exist", async () => {
        searchEntries.mockResolvedValue({ results: [mockEntry()], hasMore: false });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("All matching entries are displayed.")).toBeInTheDocument();
        });
    });

    it("does not show 'All matching entries are displayed' when there are no results", async () => {
        searchEntries.mockResolvedValue({ results: [], hasMore: false });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.queryByText("All matching entries are displayed.")).not.toBeInTheDocument();
        });
    });

    it("clicking 'Load more' calls searchEntries with page 2", async () => {
        searchEntries
            .mockResolvedValueOnce({ results: [mockEntry({ id: "1" })], hasMore: true })
            .mockResolvedValueOnce({ results: [mockEntry({ id: "2" })], hasMore: false });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("Load more")).toBeInTheDocument();
        });

        await act(async () => {
            fireEvent.click(screen.getByText("Load more"));
        });

        await waitFor(() => {
            expect(searchEntries).toHaveBeenCalledWith("food", 2);
        });
    });

    it("clicking 'Load more' appends new results to existing ones", async () => {
        searchEntries
            .mockResolvedValueOnce({
                results: [mockEntry({ id: "1", input: "food - First entry" })],
                hasMore: true,
            })
            .mockResolvedValueOnce({
                results: [mockEntry({ id: "2", input: "food - Second entry" })],
                hasMore: false,
            });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("- First entry")).toBeInTheDocument();
        });

        await act(async () => {
            fireEvent.click(screen.getByText("Load more"));
        });

        await waitFor(() => {
            expect(screen.getByText("- First entry")).toBeInTheDocument();
            expect(screen.getByText("- Second entry")).toBeInTheDocument();
        });
    });

    it("keeps existing results visible while loading more", async () => {
        let resolveLoadMore;
        searchEntries
            .mockResolvedValueOnce({
                results: [mockEntry({ id: "1", input: "food - First entry" })],
                hasMore: true,
            })
            .mockImplementationOnce(() => new Promise(resolve => { resolveLoadMore = resolve; }));

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("- First entry")).toBeInTheDocument();
        });

        // Click load more - results should stay visible while fetching
        act(() => {
            fireEvent.click(screen.getByText("Load more"));
        });

        // Existing results must still be visible while the next page is loading
        expect(screen.getByText("- First entry")).toBeInTheDocument();

        // Resolve the pending load-more fetch
        await act(async () => {
            resolveLoadMore({ results: [mockEntry({ id: "2", input: "food - Second entry" })], hasMore: false });
        });

        await waitFor(() => {
            expect(screen.getByText("- First entry")).toBeInTheDocument();
            expect(screen.getByText("- Second entry")).toBeInTheDocument();
        });
    });

    it("hides 'Load more' button after loading all results", async () => {
        searchEntries
            .mockResolvedValueOnce({ results: [mockEntry({ id: "1" })], hasMore: true })
            .mockResolvedValueOnce({ results: [mockEntry({ id: "2" })], hasMore: false });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("Load more")).toBeInTheDocument();
        });

        await act(async () => {
            fireEvent.click(screen.getByText("Load more"));
        });

        await waitFor(() => {
            expect(screen.queryByText("Load more")).not.toBeInTheDocument();
            expect(screen.getByText("All matching entries are displayed.")).toBeInTheDocument();
        });
    });

    it("ignores stale search responses when pattern changes during fetch", async () => {
        let resolveInitial;
        const initialPromise = new Promise(resolve => { resolveInitial = resolve; });

        searchEntries
            .mockImplementationOnce(() => initialPromise)
            .mockResolvedValueOnce({ results: [mockEntry({ input: "food - Food entry" })], hasMore: false });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        // Fire the initial debounced fetch (still in flight)
        act(() => { jest.runAllTimers(); });

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        // Fire the "food" debounced fetch and let it resolve
        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("- Food entry")).toBeInTheDocument();
        });

        // Resolve the stale initial fetch with different data
        await act(async () => {
            resolveInitial({ results: [mockEntry({ input: "food - Stale entry" })], hasMore: false });
        });

        // Stale results must NOT replace the food results
        expect(screen.queryByText("- Stale entry")).not.toBeInTheDocument();
        expect(screen.getByText("- Food entry")).toBeInTheDocument();
    });

    it("resets pagination when the search pattern changes", async () => {
        searchEntries
            .mockResolvedValueOnce({ results: [mockEntry({ id: "1" })], hasMore: true })
            .mockResolvedValueOnce({ results: [mockEntry({ id: "2" })], hasMore: false })
            .mockResolvedValueOnce({ results: [mockEntry({ id: "3" })], hasMore: false });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByText("Load more")).toBeInTheDocument();
        });

        await act(async () => {
            fireEvent.click(screen.getByText("Load more"));
        });

        await waitFor(() => {
            expect(screen.queryByText("Load more")).not.toBeInTheDocument();
        });

        // Change the pattern, triggering a fresh search
        fireEvent.change(input, { target: { value: "sleep" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(searchEntries).toHaveBeenLastCalledWith("sleep", 1);
        });
    });

    it("renders entry rows as anchor links with correct href", async () => {
        searchEntries.mockResolvedValue({ results: [mockEntry()] });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            const entryText = screen.getByText("- Ate pizza");
            const link = entryText.closest("a");
            expect(link).toBeInTheDocument();
            expect(link).toHaveAttribute("href", "/entry/entry-1");
        });
    });

    it("saves search state to sessionStorage when an entry link is clicked", async () => {
        searchEntries.mockResolvedValue({
            results: [mockEntry({ id: "entry-1", input: "food - Ate pizza" })],
            hasMore: false,
        });

        renderWithProviders(
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

        const link = screen.getByText("- Ate pizza").closest("a");
        fireEvent.click(link);

        const saved = JSON.parse(sessionStorage.getItem("volodyslav_search_state"));
        expect(saved).not.toBeNull();
        expect(saved.pattern).toBe("food");
        expect(saved.results).toHaveLength(1);
        expect(saved.results[0].id).toBe("entry-1");
        expect(saved.hasMore).toBe(false);
    });

    it("restores search results from sessionStorage on POP navigation without refetching", async () => {
        const restoredEntry = mockEntry({ id: "restored-1", input: "food - Restored entry" });
        sessionStorage.setItem("volodyslav_search_state", JSON.stringify({
            pattern: "food",
            results: [restoredEntry],
            page: 1,
            hasMore: false,
            error: null,
        }));

        // MemoryRouter starts with navigationType "POP", matching the back-navigation case.
        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        // Results must be visible immediately without running timers or waiting for fetch.
        await waitFor(() => {
            expect(screen.getByText("- Restored entry")).toBeInTheDocument();
        });

        // The search input should reflect the restored pattern.
        expect(screen.getByPlaceholderText("Search entries by regex...")).toHaveValue("food");

        // searchEntries must NOT have been called since we restored from sessionStorage.
        expect(searchEntries).not.toHaveBeenCalled();
    });

    it("does not show a spinner when state is restored from sessionStorage on POP navigation", async () => {
        const restoredEntry = mockEntry({ id: "restored-1", input: "food - Restored entry" });
        sessionStorage.setItem("volodyslav_search_state", JSON.stringify({
            pattern: "",
            results: [restoredEntry],
            page: 1,
            hasMore: false,
            error: null,
        }));

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        // No loading spinner should be visible when state is restored.
        await waitFor(() => {
            expect(screen.getByText("- Restored entry")).toBeInTheDocument();
        });
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });

    it("does not focus the search input on restored POP navigation", async () => {
        const restoredEntry = mockEntry({ id: "restored-1", input: "food - Restored entry" });
        sessionStorage.setItem("volodyslav_search_state", JSON.stringify({
            pattern: "food",
            results: [restoredEntry],
            page: 1,
            hasMore: false,
            error: null,
        }));
        const focusSpy = jest.spyOn(HTMLElement.prototype, "focus");

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        await waitFor(() => {
            expect(screen.getByText("- Restored entry")).toBeInTheDocument();
        });
        expect(focusSpy).not.toHaveBeenCalled();
        focusSpy.mockRestore();
    });

    it("focuses the search input when opening search with a PUSH navigation", async () => {
        useNavigationType.mockReturnValue("PUSH");
        const focusSpy = jest.spyOn(HTMLElement.prototype, "focus");

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        expect(focusSpy).toHaveBeenCalled();
        focusSpy.mockRestore();
    });

    // --- Copy as JSON button ---

    it("shows 'Copy as JSON' button when results are present", async () => {
        searchEntries.mockResolvedValue({ results: [mockEntry()], hasMore: false });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByRole("button", { name: /copy as json/i })).toBeInTheDocument();
        });
    });

    it("does not show 'Copy as JSON' button when there are no results", async () => {
        searchEntries.mockResolvedValue({ results: [], hasMore: false });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "food" } });

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.queryByRole("button", { name: /copy as json/i })).not.toBeInTheDocument();
        });
    });

    it("clicking 'Copy as JSON' calls fetchAdditionalProperties for each result", async () => {
        const entries = [
            mockEntry({ id: "e1", input: "food - Pizza" }),
            mockEntry({ id: "e2", input: "food - Salad" }),
        ];
        searchEntries.mockResolvedValue({ results: entries, hasMore: false });
        fetchAdditionalProperties.mockResolvedValue({ basic_context: [] });

        const mockWriteText = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText: mockWriteText } });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByRole("button", { name: /copy as json/i })).toBeInTheDocument();
        });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: /copy as json/i }));
        });

        await waitFor(() => {
            expect(fetchAdditionalProperties).toHaveBeenCalledWith("e1", "basic_context");
            expect(fetchAdditionalProperties).toHaveBeenCalledWith("e2", "basic_context");
        });
    });

    it("clicking 'Copy as JSON' writes correct JSON to clipboard", async () => {
        const entry = mockEntry({
            id: "e1",
            input: "food - Pizza",
            date: "2023-01-01T10:00:00.000Z",
        });
        searchEntries.mockResolvedValue({ results: [entry], hasMore: false });
        fetchAdditionalProperties.mockResolvedValue({
            basic_context: [
                { input: "text #lunch notes", date: "2023-01-01T09:00:00.000Z" },
            ],
        });

        const mockWriteText = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText: mockWriteText } });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByRole("button", { name: /copy as json/i })).toBeInTheDocument();
        });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: /copy as json/i }));
        });

        await waitFor(() => {
            expect(mockWriteText).toHaveBeenCalled();
        });

        const written = JSON.parse(mockWriteText.mock.calls[0][0]);
        expect(written).toHaveLength(1);
        expect(written[0]).toMatchObject({
            input: "food - Pizza",
            date: "2023-01-01T10:00:00.000Z",
            basicContext: [
                { input: "text #lunch notes", date: "2023-01-01T09:00:00.000Z" },
            ],
        });
    });

    it("shows success message after copying", async () => {
        searchEntries.mockResolvedValue({ results: [mockEntry()], hasMore: false });
        fetchAdditionalProperties.mockResolvedValue({ basic_context: [] });

        const mockWriteText = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText: mockWriteText } });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByRole("button", { name: /copy as json/i })).toBeInTheDocument();
        });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: /copy as json/i }));
        });

        await waitFor(() => {
            expect(screen.getByText("Copied to clipboard!")).toBeInTheDocument();
        });
    });

    it("shows error message when clipboard write fails", async () => {
        searchEntries.mockResolvedValue({ results: [mockEntry()], hasMore: false });
        fetchAdditionalProperties.mockResolvedValue({ basic_context: [] });

        const mockWriteText = jest.fn().mockRejectedValue(new Error("Clipboard not available"));
        Object.assign(navigator, { clipboard: { writeText: mockWriteText } });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByRole("button", { name: /copy as json/i })).toBeInTheDocument();
        });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: /copy as json/i }));
        });

        await waitFor(() => {
            expect(screen.getByText("Failed to copy to clipboard.")).toBeInTheDocument();
        });
    });

    it("resets copy status when search pattern changes", async () => {
        searchEntries.mockResolvedValue({ results: [mockEntry()], hasMore: false });
        fetchAdditionalProperties.mockResolvedValue({ basic_context: [] });

        const mockWriteText = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText: mockWriteText } });

        renderWithProviders(
            <MemoryRouter>
                <Search />
            </MemoryRouter>
        );

        await act(async () => { jest.runAllTimers(); });

        await waitFor(() => {
            expect(screen.getByRole("button", { name: /copy as json/i })).toBeInTheDocument();
        });

        // Copy successfully
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: /copy as json/i }));
        });

        await waitFor(() => {
            expect(screen.getByText("Copied to clipboard!")).toBeInTheDocument();
        });

        // Change the search pattern — success message should disappear
        const input = screen.getByPlaceholderText("Search entries by regex...");
        fireEvent.change(input, { target: { value: "sleep" } });

        await waitFor(() => {
            expect(screen.queryByText("Copied to clipboard!")).not.toBeInTheDocument();
        });
    });
});
