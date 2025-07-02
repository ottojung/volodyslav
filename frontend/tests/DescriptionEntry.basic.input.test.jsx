import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// Mock the API module before any imports
jest.mock("../src/DescriptionEntry/api", () => ({
    fetchRecentEntries: jest.fn(),
    submitEntry: jest.fn(),
    fetchConfig: jest.fn(),
}));

// Mock the logger module to prevent console output during tests
jest.mock("../src/DescriptionEntry/logger", () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

// Mock camera utilities to test camera integration
jest.mock("../src/DescriptionEntry/cameraUtils", () => ({
    generateRequestIdentifier: jest.fn(),
    navigateToCamera: jest.fn(),
    checkCameraReturn: jest.fn(),
    cleanupUrlParams: jest.fn(),
    restoreDescription: jest.fn(),
    retrievePhotos: jest.fn(),
}));

import DescriptionEntry from "../src/DescriptionEntry/DescriptionEntry.jsx";
// Import the mocked functions after the mock is set up
import {
    fetchRecentEntries,
    submitEntry,
    fetchConfig,
} from "../src/DescriptionEntry/api";

// Import the mocked camera functions
import {
    generateRequestIdentifier,
    navigateToCamera,
    checkCameraReturn,
    cleanupUrlParams,
    restoreDescription,
    retrievePhotos,
} from "../src/DescriptionEntry/cameraUtils";

describe("DescriptionEntry", () => {
    // Default mock config for tests that need config functionality
    const defaultMockConfig = {
        help: "Event logging help text\n\nSyntax: TYPE [MODIFIERS...] DESCRIPTION\n\nExamples:\n   food [certainty 9] earl gray tea, unsweetened\n   food [when now] [certainty 9] pizza capricciossa, medium size\n   sleep [when 5 hours ago] went to bed\n\nModifiers:\n   [when TIME] - specify when the event happened\n   [certainty LEVEL] - specify how certain you are (1-10)\n\nTypes available: food, sleep, exercise, work, social",
        shortcuts: [
            ["breakfast", "food [when this morning]", "Quick breakfast entry"],
            ["lunch", "food [when noon]", "Quick lunch entry"],
            ["dinner", "food [when evening]", "Quick dinner entry"],
            ["\\bcoffee\\b", "food [certainty 10] coffee", "Coffee shortcut"],
            ["\\btea\\b", "food [certainty 10] tea", "Tea shortcut"],
            [
                "slept (\\d+)h",
                "sleep [duration $1 hours]",
                "Sleep duration shortcut",
            ],
            [
                "worked (\\d+)h",
                "work [duration $1 hours]",
                "Work duration shortcut",
            ],
        ],
    };

    beforeEach(() => {
        // Reset mocks before each test
        fetchRecentEntries.mockClear();
        submitEntry.mockClear();
        fetchConfig.mockClear();

        // Reset camera mocks - use mockReset to clear all state
        generateRequestIdentifier.mockReset();
        navigateToCamera.mockReset();
        checkCameraReturn.mockReset();
        cleanupUrlParams.mockReset();
        restoreDescription.mockReset();
        retrievePhotos.mockReset();

        // Set default mock implementations that resolve immediately
        fetchRecentEntries.mockResolvedValue([]);
        submitEntry.mockResolvedValue({
            success: true,
            entry: { input: "test" },
        });
        // Use default mock config instead of null
        fetchConfig.mockResolvedValue(defaultMockConfig);
        // Set default camera mock implementations - ensure clean state
        generateRequestIdentifier.mockReturnValue("test-req-id-123");
        checkCameraReturn.mockReturnValue({
            isReturn: false,
            requestIdentifier: null,
        });
        restoreDescription.mockReturnValue(null);
        retrievePhotos.mockReturnValue([]);

        // Clear sessionStorage to ensure clean state
        Object.defineProperty(window, "sessionStorage", {
            value: {
                getItem: jest.fn(),
                setItem: jest.fn(),
                removeItem: jest.fn(),
                clear: jest.fn(),
            },
            writable: true,
        });
    });

    it("clears input and refetches entries after successful submission", async () => {
        submitEntry.mockResolvedValue({
            success: true,
            entry: { input: "processed test event" },
        });

        render(<DescriptionEntry />);

        // Wait for component to be fully loaded
        await waitFor(() => {
            expect(fetchConfig).toHaveBeenCalled();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );

        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Submit using Enter key
        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });

        await waitFor(() => {
            expect(input.value).toBe("");
        });

        // Should refetch entries after submission
        await waitFor(() => {
            expect(fetchRecentEntries).toHaveBeenCalledTimes(2); // Once on mount, once after submit
        });
    });


    it("handles submission errors gracefully", async () => {
        submitEntry.mockRejectedValue(new Error("Network error"));

        render(<DescriptionEntry />);

        // Wait for component to be fully loaded
        await waitFor(() => {
            expect(fetchConfig).toHaveBeenCalled();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        // Type something
        fireEvent.change(input, { target: { value: "test event" } });

        // Submit using Enter key
        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });

        await waitFor(() => {
            expect(submitEntry).toHaveBeenCalledWith(
                "test event",
                undefined,
                []
            );
        });

        // Input should not be cleared on error
        expect(input.value).toBe("test event");
    });

    it("does not submit empty or whitespace-only input", async () => {
        render(<DescriptionEntry />);

        // Wait for component to settle
        await waitFor(() => {
            expect(screen.getByText("Help")).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );
        // Try to submit empty input
        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });
        expect(submitEntry).not.toHaveBeenCalled();

        // Try to submit whitespace-only input
        fireEvent.change(input, { target: { value: "   " } });
        fireEvent.keyUp(input, { key: "Enter", code: "Enter" });
        expect(submitEntry).not.toHaveBeenCalled();
    });

    it("focuses input field on mount", async () => {
        render(<DescriptionEntry />);

        // Wait for component to be fully loaded
        await waitFor(() => {
            expect(fetchConfig).toHaveBeenCalled();
        });

        const input = screen.getByPlaceholderText(
            "Type your event description here..."
        );

        expect(input).toHaveFocus();
    });

});
