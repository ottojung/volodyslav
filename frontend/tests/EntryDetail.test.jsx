import React from "react";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// Mock the Search API module
jest.mock("../src/Search/api", () => ({
    searchEntries: jest.fn(),
    fetchEntryById: jest.fn(),
    deleteEntryById: jest.fn(),
    fetchAdditionalProperties: jest.fn(),
    fetchEntryAssets: jest.fn(),
}));

// Mock the api_base_url module
jest.mock("../src/api_base_url.js", () => ({
    API_BASE_URL: "/api",
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
import { fetchEntryById, deleteEntryById, fetchAdditionalProperties, fetchEntryAssets } from "../src/Search/api";

const mockEntry = {
    id: "entry-123",
    date: "2023-01-01T10:00:00.000Z",
    input: "food [certainty 9] - Ate pizza",
    original: "food - Ate pizza",
    creator: { name: "test", uuid: "test-uuid", version: "1.0" },
};

const mockEntryNoModifiers = {
    ...mockEntry,
    id: "entry-456",
    input: "food - Ate pizza",
    original: "food - Ate pizza",
};

const longFieldValue = `Long field ${"x".repeat(120)} ending`;
const collapsedLongFieldValue = `${longFieldValue.slice(0, 100)}…`;

function makeDeferred() {
    /** @type {(value: import("../src/Search/api").AdditionalProperties) => void} */
    let resolveDeferred;
    const promise = new Promise((promiseResolve) => {
        resolveDeferred = promiseResolve;
    });
    return { promise, resolve: resolveDeferred };
}

function renderWithRoute(pathname, state = undefined) {
    return render(
        <MemoryRouter initialEntries={[{ pathname, state }]}>
            <Routes>
                <Route path="/entry/:id" element={<EntryDetail />} />
            </Routes>
        </MemoryRouter>
    );
}

function makeNeverResolvingPromise() {
    return new Promise(() => {});
}

describe("EntryDetail page", () => {
    beforeEach(() => {
        fetchEntryById.mockClear();
        deleteEntryById.mockClear();
        fetchAdditionalProperties.mockClear();
        fetchAdditionalProperties.mockImplementation(() => makeNeverResolvingPromise());
        fetchEntryAssets.mockClear();
        fetchEntryAssets.mockImplementation(() => makeNeverResolvingPromise());
    });

    // --- Rendering with state ---

    it("renders entry fields when entry is passed via state", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getAllByText("entry-123").length).toBeGreaterThan(0);
        expect(screen.getAllByText("food - Ate pizza").length).toBeGreaterThan(0);
    });

    it("shows summary field keys by default and hides derived fields", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getByText("original")).toBeInTheDocument();
        expect(screen.getByText("date")).toBeInTheDocument();
        expect(screen.getByText("id")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Show derived" })).toBeInTheDocument();
        expect(screen.queryByText("type")).not.toBeInTheDocument();
        expect(screen.queryByText("description")).not.toBeInTheDocument();
        expect(screen.queryByText("input")).not.toBeInTheDocument();
        expect(screen.queryByText("creator")).not.toBeInTheDocument();
    });

    it("shows summary fields in the requested order", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        const originalField = screen.getByText("original");
        const dateField = screen.getByText("date");
        const idField = screen.getByText("id");

        expect(originalField.compareDocumentPosition(dateField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(dateField.compareDocumentPosition(idField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("shows modifier field keys with 'modifiers.' prefix after expanding derived fields", async () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Show derived" }));
        });

        expect(screen.getByText("modifiers.certainty")).toBeInTheDocument();
    });

    it("shows modifier value after expanding derived fields", async () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Show derived" }));
        });

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

    it("shows creator fields with 'creator.' prefix after expanding derived fields", async () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Show derived" }));
        });

        expect(screen.getByText("creator.name")).toBeInTheDocument();
        expect(screen.getByText("creator.uuid")).toBeInTheDocument();
        expect(screen.getByText("creator.version")).toBeInTheDocument();
        expect(screen.getByText("test")).toBeInTheDocument();
        expect(screen.getByText("test-uuid")).toBeInTheDocument();
        expect(screen.getByText("1.0")).toBeInTheDocument();
    });

    it("shows exactly 10 fields for an entry with 1 modifier after expanding derived fields", async () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Show derived" }));
        });

        const fieldLabels = ["original", "date", "id", "type", "description", "input", "creator.name", "creator.uuid", "creator.version", "modifiers.certainty"];
        for (const label of fieldLabels) {
            expect(screen.getByText(label)).toBeInTheDocument();
        }
    });

    it("shows exactly 9 fields for an entry with no modifiers after expanding derived fields", async () => {
        renderWithRoute("/entry/entry-456", { entry: mockEntryNoModifiers });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Show derived" }));
        });

        const fieldLabels = ["original", "date", "id", "type", "description", "input", "creator.name", "creator.uuid", "creator.version"];
        for (const label of fieldLabels) {
            expect(screen.getByText(label)).toBeInTheDocument();
        }
    });

    it("renders copy buttons for the visible summary fields by default", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getByRole("button", { name: "Copy original" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Copy date" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Copy id" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Copy type" })).not.toBeInTheDocument();
    });

    it("does not fetch from API when entry is in state", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(fetchEntryById).not.toHaveBeenCalled();
    });

    it("shows the date value from the entry", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getAllByText("2023-01-01T10:00:00.000Z").length).toBeGreaterThan(0);
    });

    it("uses normal word breaking for entry field values", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getByText("food - Ate pizza")).toHaveStyle({ wordBreak: "normal" });
    });

    it("shows multiple modifier fields when entry has multiple modifiers", async () => {
        const entryWithMultipleModifiers = {
            ...mockEntry,
            input: "food [certainty 9] [when yesterday] - Ate pizza",
        };
        renderWithRoute("/entry/entry-123", { entry: entryWithMultipleModifiers });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Show derived" }));
        });

        expect(screen.getByText("modifiers.certainty")).toBeInTheDocument();
        expect(screen.getByText("modifiers.when")).toBeInTheDocument();
        expect(screen.getByText("9")).toBeInTheDocument();
        expect(screen.getByText("yesterday")).toBeInTheDocument();
    });

    it("collapses long field values by default and expands them on demand", async () => {
        renderWithRoute("/entry/entry-123", {
            entry: {
                ...mockEntry,
                input: `food ${longFieldValue}`,
            },
        });

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Show derived" }));
        });

        expect(screen.getByText(collapsedLongFieldValue)).toBeInTheDocument();
        expect(screen.queryByText(longFieldValue)).not.toBeInTheDocument();

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Show full description" }));
        });

        expect(screen.getByText(longFieldValue)).toBeInTheDocument();
        expect(screen.queryByText(collapsedLongFieldValue)).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Show less description" })).toBeInTheDocument();
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

        expect(screen.queryByText("id")).not.toBeInTheDocument();
        expect(screen.getAllByText("Loading...")).toHaveLength(1);

        await act(async () => { resolveEntry(mockEntry); });

        await waitFor(() => {
            expect(screen.getAllByText("entry-123").length).toBeGreaterThan(0);
        });
    });

    it("renders fetched entry fields after loading", async () => {
        fetchEntryById.mockResolvedValue(mockEntry);

        renderWithRoute("/entry/entry-123");

        await waitFor(() => {
            expect(screen.getByText("id")).toBeInTheDocument();
            expect(screen.getByText("original")).toBeInTheDocument();
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

        // Click the copy button for the "id" field specifically
        const copyButton = screen.getByRole("button", { name: "Copy id" });
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

        // Click the copy button for the "id" field specifically
        const copyButton = screen.getByRole("button", { name: "Copy id" });
        await act(async () => { fireEvent.click(copyButton); });

        expect(mockWriteText).toHaveBeenCalled();
    });

    // --- Delete button ---

    it("shows a delete button", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getByRole("button", { name: /delete/i })).toBeInTheDocument();
    });

    it("calls deleteEntryById with the entry id when delete button is clicked", async () => {
        deleteEntryById.mockResolvedValue(true);

        render(
            <MemoryRouter initialEntries={[{ pathname: "/entry/entry-123", state: { entry: mockEntry } }]}>
                <Routes>
                    <Route path="/entry/:id" element={<EntryDetail />} />
                    <Route path="/search" element={<div>Search Page</div>} />
                </Routes>
            </MemoryRouter>
        );

        const deleteButton = screen.getByRole("button", { name: /delete/i });
        await act(async () => { fireEvent.click(deleteButton); });

        expect(deleteEntryById).toHaveBeenCalledWith("entry-123");
    });

    it("navigates to /search after successful deletion", async () => {
        deleteEntryById.mockResolvedValue(true);

        render(
            <MemoryRouter initialEntries={[{ pathname: "/entry/entry-123", state: { entry: mockEntry } }]}>
                <Routes>
                    <Route path="/entry/:id" element={<EntryDetail />} />
                    <Route path="/search" element={<div>Search Page</div>} />
                </Routes>
            </MemoryRouter>
        );

        const deleteButton = screen.getByRole("button", { name: /delete/i });
        await act(async () => { fireEvent.click(deleteButton); });

        await waitFor(() => {
            expect(screen.getByText("Search Page")).toBeInTheDocument();
        });
    });

    it("stays on entry page when deletion fails", async () => {
        deleteEntryById.mockResolvedValue(false);

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        const deleteButton = screen.getByRole("button", { name: /delete/i });
        await act(async () => { fireEvent.click(deleteButton); });

        await waitFor(() => {
            expect(screen.getByRole("button", { name: /delete/i })).toBeInTheDocument();
        });
    });

    // --- Additional Properties section ---

    it("shows the Additional Properties section header", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getByText("Computed Properties")).toBeInTheDocument();
    });

    it("shows an optimistic loading list while additional properties are still loading", () => {
        fetchAdditionalProperties.mockReturnValue(new Promise(() => {}));
        fetchEntryAssets.mockReturnValue(new Promise(() => {}));

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getByText("Loading calories...")).toBeInTheDocument();
        expect(screen.getByText("Loading transcription...")).toBeInTheDocument();
        expect(screen.queryByText("None")).not.toBeInTheDocument();
    });

    it("shows additional properties progressively as each request resolves", async () => {
        const caloriesDeferred = makeDeferred();
        const transcriptionDeferred = makeDeferred();

        fetchAdditionalProperties.mockImplementation((id, propertyName) => {
            if (id !== "entry-123") {
                return Promise.resolve({});
            }

            if (propertyName === "calories") {
                return caloriesDeferred.promise;
            }

            if (propertyName === "transcription") {
                return transcriptionDeferred.promise;
            }

            return Promise.resolve({});
        });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getByText("Loading calories...")).toBeInTheDocument();
        expect(screen.getByText("Loading transcription...")).toBeInTheDocument();

        await act(async () => {
            caloriesDeferred.resolve({ calories: 420 });
        });

        await waitFor(() => {
            expect(screen.getByText("calories")).toBeInTheDocument();
            expect(screen.getByText("420")).toBeInTheDocument();
            expect(screen.queryByText("Loading calories...")).not.toBeInTheDocument();
            expect(screen.getByText("Loading transcription...")).toBeInTheDocument();
        });

        await act(async () => {
            transcriptionDeferred.resolve({});
        });

        await waitFor(() => {
            expect(screen.queryByText("Loading transcription...")).not.toBeInTheDocument();
        });
    });

    it("shows 'None' when additional properties are empty", async () => {
        fetchAdditionalProperties.mockResolvedValue({});

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getAllByText("None").length).toBeGreaterThanOrEqual(1);
        });
    });

    it("shows calories field when additional properties contain calories", async () => {
        fetchAdditionalProperties.mockResolvedValue({ calories: 420 });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText("calories")).toBeInTheDocument();
            expect(screen.getByText("420")).toBeInTheDocument();
        });
    });

    it("does not show calories field when calories is absent", async () => {
        fetchAdditionalProperties.mockResolvedValue({});

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getAllByText("None").length).toBeGreaterThanOrEqual(1);
        });

        expect(screen.queryByText("calories")).not.toBeInTheDocument();
    });

    it("calls fetchAdditionalProperties with the entry id and property names", async () => {
        fetchAdditionalProperties.mockResolvedValue({});

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(fetchAdditionalProperties).toHaveBeenNthCalledWith(1, "entry-123", "calories");
            expect(fetchAdditionalProperties).toHaveBeenNthCalledWith(2, "entry-123", "transcription");
            expect(fetchAdditionalProperties).toHaveBeenNthCalledWith(3, "entry-123", "basic_context");
        });
    });

    it("shows a transcription error when the API returns an errors object", async () => {
        fetchAdditionalProperties.mockImplementation((id, propertyName) => {
            if (propertyName === "transcription") {
                return Promise.resolve({ errors: { transcription: "AI transcription service unavailable" } });
            }
            return Promise.resolve({});
        });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText(/transcription error/i)).toBeInTheDocument();
            expect(screen.getByText("AI transcription service unavailable")).toBeInTheDocument();
        });
    });

    it("shows a calories error when the API returns an errors object", async () => {
        fetchAdditionalProperties.mockImplementation((id, propertyName) => {
            if (propertyName === "calories") {
                return Promise.resolve({ errors: { calories: "AI calories service unavailable" } });
            }
            return Promise.resolve({});
        });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText(/calories error/i)).toBeInTheDocument();
            expect(screen.getByText("AI calories service unavailable")).toBeInTheDocument();
        });
    });

    it("shows both errors and successful property values when mixed", async () => {
        fetchAdditionalProperties.mockImplementation((id, propertyName) => {
            if (propertyName === "calories") {
                return Promise.resolve({ calories: 420 });
            }
            if (propertyName === "transcription") {
                return Promise.resolve({ errors: { transcription: "Transcription failed" } });
            }
            return Promise.resolve({});
        });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText("calories")).toBeInTheDocument();
            expect(screen.getByText("420")).toBeInTheDocument();
            expect(screen.getByText(/transcription error/i)).toBeInTheDocument();
            expect(screen.getByText("Transcription failed")).toBeInTheDocument();
        });
    });

    it("does not show 'None' when there are only errors", async () => {
        fetchAdditionalProperties.mockImplementation((id, propertyName) => {
            if (propertyName === "transcription") {
                return Promise.resolve({ errors: { transcription: "Transcription failed" } });
            }
            if (propertyName === "basic_context") {
                return Promise.resolve({ basic_context: ["food - Ate pizza"] });
            }
            return Promise.resolve({});
        });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText(/transcription error/i)).toBeInTheDocument();
        });

        const noneTexts = screen.queryAllByText("None");
        // 'None' should not appear in the Computed Properties section (only errors are present)
        // (it may still appear in the Media section if assets haven't loaded yet,
        //  but that's handled by fetchEntryAssets which is a never-resolving mock here)
        // Since fetchEntryAssets never resolves, Media will be in loading state (spinner, no 'None').
        expect(noneTexts.length).toBe(0);
    });

    it("merges errors from multiple property requests correctly", async () => {
        fetchAdditionalProperties.mockImplementation((id, propertyName) => {
            if (propertyName === "calories") {
                return Promise.resolve({ errors: { calories: "Calories error" } });
            }
            if (propertyName === "transcription") {
                return Promise.resolve({ errors: { transcription: "Transcription error" } });
            }
            return Promise.resolve({});
        });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getAllByText(/calories error/i).length).toBeGreaterThanOrEqual(1);
            expect(screen.getByText("Calories error")).toBeInTheDocument();
            expect(screen.getAllByText(/transcription error/i).length).toBeGreaterThanOrEqual(1);
            expect(screen.getByText("Transcription error")).toBeInTheDocument();
        });
    });

    it("collapses long additional property values by default and expands them on demand", async () => {
        fetchAdditionalProperties.mockImplementation((id, propertyName) => {
            if (id !== "entry-123") {
                return Promise.resolve({});
            }

            if (propertyName === "transcription") {
                return Promise.resolve({ transcription: longFieldValue });
            }

            return Promise.resolve({});
        });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText(collapsedLongFieldValue)).toBeInTheDocument();
        });
        expect(screen.queryByText(longFieldValue)).not.toBeInTheDocument();

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Show full transcription" }));
        });

        expect(screen.getByText(longFieldValue)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Show less transcription" })).toBeInTheDocument();
    });

    // --- Basic Context section ---

    it("shows the Basic Context section header", () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getByText("Basic Context")).toBeInTheDocument();
    });

    it("shows loading state in Basic Context section while fetching", () => {
        fetchAdditionalProperties.mockReturnValue(new Promise(() => {}));

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        expect(screen.getByText("Loading basic context...")).toBeInTheDocument();
    });

    it("shows 'None' in Basic Context when basic_context is empty", async () => {
        fetchAdditionalProperties.mockResolvedValue({ basic_context: [] });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText("Basic Context")).toBeInTheDocument();
        });

        const allNones = screen.getAllByText("None");
        expect(allNones.length).toBeGreaterThanOrEqual(1);
    });

    it("renders basic context inputs as a list", async () => {
        fetchAdditionalProperties.mockImplementation((id, propertyName) => {
            if (propertyName === "basic_context") {
                return Promise.resolve({ basic_context: ["text some context event", "text another context event"] });
            }
            return Promise.resolve({});
        });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText("text some context event")).toBeInTheDocument();
            expect(screen.getByText("text another context event")).toBeInTheDocument();
        });
    });

    it("uses normal word breaking for basic context inputs", async () => {
        fetchAdditionalProperties.mockImplementation((id, propertyName) => {
            if (propertyName === "basic_context") {
                return Promise.resolve({ basic_context: ["context phrase with several words"] });
            }
            return Promise.resolve({});
        });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText("context phrase with several words")).toHaveStyle({ wordBreak: "normal" });
        });
    });

    it("does not show basic context inputs in the Computed Properties section", async () => {
        fetchAdditionalProperties.mockImplementation((id, propertyName) => {
            if (propertyName === "basic_context") {
                return Promise.resolve({ basic_context: ["food - Ate pizza"] });
            }
            return Promise.resolve({});
        });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText("food - Ate pizza")).toBeInTheDocument();
        });

        // basic_context key should not appear as a field row label in Computed Properties
        expect(screen.queryByText("basic_context")).not.toBeInTheDocument();
    });

    it("shows a basic context error in the Basic Context card, not Computed Properties", async () => {
        fetchAdditionalProperties.mockImplementation((id, propertyName) => {
            if (propertyName === "basic_context") {
                return Promise.resolve({ errors: { basic_context: "Context service unavailable" } });
            }
            return Promise.resolve({});
        });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText(/basic context error/i)).toBeInTheDocument();
            expect(screen.getByText("Context service unavailable")).toBeInTheDocument();
        });

        // The error must not appear inside Computed Properties
        expect(screen.queryByText(/basic_context error/i)).not.toBeInTheDocument();
    });

    it("does not show 'None' in Basic Context when there is a basic_context error", async () => {
        fetchAdditionalProperties.mockImplementation((id, propertyName) => {
            if (propertyName === "basic_context") {
                return Promise.resolve({ errors: { basic_context: "Context service unavailable" } });
            }
            if (propertyName === "calories") {
                return Promise.resolve({ calories: 100 });
            }
            return Promise.resolve({});
        });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText(/basic context error/i)).toBeInTheDocument();
            expect(screen.getByText("Context service unavailable")).toBeInTheDocument();
        });

        // The Basic Context card must show the error, not 'None'
        expect(screen.queryByText("None")).not.toBeInTheDocument();
    });

    it("shows a calories error in Computed Properties but not in Basic Context", async () => {
        fetchAdditionalProperties.mockImplementation((id, propertyName) => {
            if (propertyName === "calories") {
                return Promise.resolve({ errors: { calories: "Calories service unavailable" } });
            }
            if (propertyName === "basic_context") {
                return Promise.resolve({ basic_context: ["text some event"] });
            }
            return Promise.resolve({});
        });

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText(/calories error/i)).toBeInTheDocument();
            expect(screen.getByText("text some event")).toBeInTheDocument();
        });

        // calories error appears in Computed Properties, not Basic Context
        expect(screen.queryByText(/basic context error/i)).not.toBeInTheDocument();
    });

    // --- Media / Assets section ---

    it("shows the Media section header", async () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText("Media")).toBeInTheDocument();
        });
    });

    it("calls fetchEntryAssets with the entry id", async () => {
        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(fetchEntryAssets).toHaveBeenCalledWith("entry-123");
        });
    });

    it("shows 'None' when there are no assets", async () => {
        fetchEntryAssets.mockResolvedValue([]);

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            // "None" appears both for additional properties and media
            const noneElements = screen.getAllByText("None");
            expect(noneElements.length).toBeGreaterThanOrEqual(1);
        });
    });

    it("does not show 'None' in Media while assets are loading", () => {
        fetchEntryAssets.mockReturnValue(new Promise(() => {}));

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        // While loading, there should be a spinner but not the "None" empty state yet
        expect(screen.queryByText("Media")).toBeInTheDocument();
        expect(screen.queryByText("None")).not.toBeInTheDocument();
    });

    it("shows Photos section when image assets are present", async () => {
        fetchEntryAssets.mockResolvedValue([
            { filename: "photo.jpg", url: "/assets/2024-01/01/entry-123/photo.jpg", mediaType: "image" },
        ]);

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText("Photos")).toBeInTheDocument();
        });
    });

    it("renders image with correct src when image asset is present", async () => {
        fetchEntryAssets.mockResolvedValue([
            { filename: "photo.jpg", url: "/assets/2024-01/01/entry-123/photo.jpg", mediaType: "image" },
        ]);

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            const img = screen.getByAltText("photo.jpg");
            expect(img).toBeInTheDocument();
            expect(img).toHaveAttribute("src", "/api/assets/2024-01/01/entry-123/photo.jpg");
        });
    });

    it("renders image as a link to the full resolution image", async () => {
        fetchEntryAssets.mockResolvedValue([
            { filename: "photo.jpg", url: "/assets/2024-01/01/entry-123/photo.jpg", mediaType: "image" },
        ]);

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            const link = screen.getByRole("link", { name: /photo\.jpg/i });
            expect(link).toHaveAttribute("href", "/api/assets/2024-01/01/entry-123/photo.jpg");
        });
    });

    it("renders image link without target=_blank so it opens in the same tab", async () => {
        fetchEntryAssets.mockResolvedValue([
            { filename: "photo.jpg", url: "/assets/2024-01/01/entry-123/photo.jpg", mediaType: "image" },
        ]);

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            const link = screen.getByRole("link", { name: /photo\.jpg/i });
            expect(link).not.toHaveAttribute("target", "_blank");
        });
    });

    it("shows Audio section when audio assets are present", async () => {
        fetchEntryAssets.mockResolvedValue([
            { filename: "recording.m4a", url: "/assets/2024-01/01/entry-123/recording.m4a", mediaType: "audio" },
        ]);

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText("Audio")).toBeInTheDocument();
        });
    });

    it("renders audio element with correct src when audio asset is present", async () => {
        fetchEntryAssets.mockResolvedValue([
            { filename: "recording.m4a", url: "/assets/2024-01/01/entry-123/recording.m4a", mediaType: "audio" },
        ]);

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            const audio = document.querySelector("audio");
            expect(audio).toBeInTheDocument();
            expect(audio).toHaveAttribute("src", "/api/assets/2024-01/01/entry-123/recording.m4a");
        });
    });

    it("shows both Photos and Audio sections when both types are present", async () => {
        fetchEntryAssets.mockResolvedValue([
            { filename: "photo.jpg", url: "/assets/2024-01/01/entry-123/photo.jpg", mediaType: "image" },
            { filename: "audio.mp3", url: "/assets/2024-01/01/entry-123/audio.mp3", mediaType: "audio" },
        ]);

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText("Photos")).toBeInTheDocument();
            expect(screen.getByText("Audio")).toBeInTheDocument();
        });
    });

    it("shows the audio filename", async () => {
        fetchEntryAssets.mockResolvedValue([
            { filename: "my-recording.mp3", url: "/assets/2024-01/01/entry-123/my-recording.mp3", mediaType: "audio" },
        ]);

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText("my-recording.mp3")).toBeInTheDocument();
        });
    });

    it("shows 'Other files' section when other-type assets are present", async () => {
        fetchEntryAssets.mockResolvedValue([
            { filename: "document.pdf", url: "/assets/2024-01/01/entry-123/document.pdf", mediaType: "other" },
        ]);

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText("Other files")).toBeInTheDocument();
        });
    });

    it("does not show 'None' when only other-type assets are present", async () => {
        fetchAdditionalProperties.mockResolvedValue({ calories: 100, basic_context: ["food - Ate pizza"] });
        fetchEntryAssets.mockResolvedValue([
            { filename: "document.pdf", url: "/assets/2024-01/01/entry-123/document.pdf", mediaType: "other" },
        ]);

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText("Other files")).toBeInTheDocument();
        });

        expect(screen.queryByText("None")).not.toBeInTheDocument();
    });

    it("renders a link for other-type assets", async () => {
        fetchEntryAssets.mockResolvedValue([
            { filename: "document.pdf", url: "/assets/2024-01/01/entry-123/document.pdf", mediaType: "other" },
        ]);

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            const link = screen.getByRole("link", { name: /document\.pdf/i });
            expect(link).toHaveAttribute("href", "/api/assets/2024-01/01/entry-123/document.pdf");
        });
    });

    it("shows the filename in the other-type asset link", async () => {
        fetchEntryAssets.mockResolvedValue([
            { filename: "notes.txt", url: "/assets/2024-01/01/entry-123/notes.txt", mediaType: "other" },
        ]);

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText("notes.txt")).toBeInTheDocument();
        });
    });

    it("shows all three sections when assets of all types are present", async () => {
        fetchEntryAssets.mockResolvedValue([
            { filename: "photo.jpg", url: "/assets/2024-01/01/entry-123/photo.jpg", mediaType: "image" },
            { filename: "audio.mp3", url: "/assets/2024-01/01/entry-123/audio.mp3", mediaType: "audio" },
            { filename: "document.pdf", url: "/assets/2024-01/01/entry-123/document.pdf", mediaType: "other" },
        ]);

        renderWithRoute("/entry/entry-123", { entry: mockEntry });

        await waitFor(() => {
            expect(screen.getByText("Photos")).toBeInTheDocument();
            expect(screen.getByText("Audio")).toBeInTheDocument();
            expect(screen.getByText("Other files")).toBeInTheDocument();
        });
    });
});
