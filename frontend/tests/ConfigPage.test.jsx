import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter } from "react-router-dom";

// Mock the API module before any imports
jest.mock("../src/DescriptionEntry/api", () => ({
    fetchRecentEntries: jest.fn(),
    submitEntry: jest.fn(),
    fetchConfig: jest.fn(),
    updateConfig: jest.fn(),
    deleteEntry: jest.fn(),
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

import ConfigPage from "../src/ConfigPage/ConfigPage.jsx";
import { fetchConfig, updateConfig } from "../src/DescriptionEntry/api";

/**
 * Helper to render ConfigPage inside a router context.
 */
function renderConfigPage() {
    return render(
        <MemoryRouter>
            <ConfigPage />
        </MemoryRouter>
    );
}

describe("ConfigPage", () => {
    beforeEach(() => {
        fetchConfig.mockClear();
        updateConfig.mockClear();
    });

    it("shows a loading spinner while config is being fetched", () => {
        fetchConfig.mockImplementation(() => new Promise(() => {}));
        renderConfigPage();
        expect(screen.getByText("Loading configuration...")).toBeInTheDocument();
    });

    it("renders the page with help text and shortcuts after loading", async () => {
        fetchConfig.mockResolvedValue({
            help: "My help text",
            shortcuts: [
                ["breakfast", "food [when this morning]", "Quick breakfast"],
            ],
        });

        renderConfigPage();

        await waitFor(() => {
            expect(screen.getByText("Configuration")).toBeInTheDocument();
        });

        const textarea = screen.getByPlaceholderText("Help text shown to users...");
        expect(textarea.value).toBe("My help text");

        expect(screen.getByDisplayValue("breakfast")).toBeInTheDocument();
        expect(screen.getByDisplayValue("food [when this morning]")).toBeInTheDocument();
        expect(screen.getByDisplayValue("Quick breakfast")).toBeInTheDocument();
    });

    it("renders with empty state when no config exists", async () => {
        fetchConfig.mockResolvedValue(null);

        renderConfigPage();

        await waitFor(() => {
            expect(screen.getByText("Configuration")).toBeInTheDocument();
        });

        expect(
            screen.getByText(/No shortcuts yet/)
        ).toBeInTheDocument();
    });

    it("adds a new shortcut row when Add Shortcut is clicked", async () => {
        fetchConfig.mockResolvedValue({ help: "", shortcuts: [] });

        renderConfigPage();

        await waitFor(() => {
            expect(screen.getByText("+ Add Shortcut")).toBeInTheDocument();
        });

        fireEvent.click(screen.getByText("+ Add Shortcut"));

        const patternInputs = screen.getAllByPlaceholderText("e.g. breakfast");
        expect(patternInputs.length).toBe(1);
    });

    it("deletes a shortcut row when delete is clicked", async () => {
        fetchConfig.mockResolvedValue({
            help: "",
            shortcuts: [["abc", "def", "test"]],
        });

        renderConfigPage();

        await waitFor(() => {
            expect(screen.getByDisplayValue("abc")).toBeInTheDocument();
        });

        const deleteButton = screen.getByLabelText("Delete shortcut");
        fireEvent.click(deleteButton);

        expect(screen.queryByDisplayValue("abc")).not.toBeInTheDocument();
    });

    it("calls updateConfig with current state on save", async () => {
        fetchConfig.mockResolvedValue({
            help: "original help",
            shortcuts: [],
        });
        updateConfig.mockResolvedValue({ help: "updated help", shortcuts: [] });

        renderConfigPage();

        await waitFor(() => {
            expect(screen.getByText("Save Configuration")).toBeInTheDocument();
        });

        const textarea = screen.getByPlaceholderText("Help text shown to users...");
        fireEvent.change(textarea, { target: { value: "updated help" } });

        fireEvent.click(screen.getByText("Save Configuration"));

        await waitFor(() => {
            expect(updateConfig).toHaveBeenCalledWith({
                help: "updated help",
                shortcuts: [],
            });
        });
    });
});
